import { randomUUID } from "node:crypto";

import type { TokenIdentity } from "../../http/token-store.js";
import { FRONT_PREFIX, PROXY_BASE_PATH } from "../shared/paths.js";
import { recordingFetch, ReleaseScopeRecord } from "./lease-end.js";
import type { AgentDeviceUpstream } from "./upstream.js";

type ProxyModule = typeof import("@agent-device/proxy");
type DaemonProxy = ReturnType<ProxyModule["createDaemonProxy"]>;

// why: the proxy hands `authenticate` a copy of the request, so the tag travels as a header the front always overwrites.
const TAG_HEADER = "x-simlock-front-tag";
const PREFLIGHT_PATH = `${PROXY_BASE_PATH}/upload/preflight`;

export type HostStatus =
  | { readonly state: "running"; readonly leaseMaxTtlMs: number }
  | { readonly state: "unavailable"; readonly reason: string };

function stripBodyHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete("content-length");
  copy.delete("content-encoding");
  return copy;
}

export class AgentDeviceHost {
  readonly #identities = new Map<string, TokenIdentity>();
  #loading: Promise<ProxyModule | undefined> | undefined;
  #loadError: string | undefined;
  #proxy: { readonly generation: number; readonly proxy: DaemonProxy } | undefined;

  readonly #upstreamFetch: (request: Request) => Promise<Response>;

  constructor(
    readonly upstream: AgentDeviceUpstream,
    record: ReleaseScopeRecord = new ReleaseScopeRecord(),
  ) {
    this.#upstreamFetch = recordingFetch(upstream, record);
  }

  async status(): Promise<HostStatus> {
    const current = this.upstream.current();
    if (current.state === "unavailable") return current;
    await this.#load();
    if (this.#loadError !== undefined) return { reason: this.#loadError, state: "unavailable" };
    return { leaseMaxTtlMs: current.leaseMaxTtlMs, state: "running" };
  }

  tag(request: Request, identity: TokenIdentity): string {
    const tag = randomUUID();
    this.#identities.set(tag, identity);
    request.headers.set(TAG_HEADER, tag);
    return tag;
  }

  authenticate(request: Request): { readonly tenantId: string } | null {
    const tag = request.headers.get(TAG_HEADER);
    const identity = tag === null ? undefined : this.#identities.get(tag);
    return identity === undefined ? null : { tenantId: identity.requesterId };
  }

  async forward(request: Request, identity: TokenIdentity): Promise<Response> {
    const status = await this.status();
    if (status.state === "unavailable") throw new Error(status.reason);
    const module = await this.#load();
    const current = this.upstream.current();
    if (module === undefined || current.state === "unavailable") {
      throw new Error(this.#loadError ?? "unavailable");
    }
    if (this.#proxy?.generation !== current.generation) {
      this.#proxy = {
        generation: current.generation,
        proxy: module.createDaemonProxy({
          authenticate: (tagged) => this.authenticate(tagged),
          upstreamBaseUrl: current.baseUrl,
          upstreamFetch: (upstream) => this.#upstreamFetch(upstream),
          upstreamToken: current.token,
        }),
      };
    }
    const proxied = this.#rewrite(request);
    const tag = this.tag(proxied, identity);
    try {
      const response = await this.#proxy.proxy.handle(proxied);
      return new URL(proxied.url).pathname === PREFLIGHT_PATH
        ? await this.#withTicketPrefix(response)
        : response;
    } finally {
      this.#identities.delete(tag);
    }
  }

  #load(): Promise<ProxyModule | undefined> {
    this.#loading ??= import("@agent-device/proxy").then(
      (module) => module,
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.#loadError = `could not load @agent-device/proxy: ${reason}`;
        return undefined;
      },
    );
    return this.#loading;
  }

  #rewrite(request: Request): Request {
    const url = new URL(request.url);
    if (url.pathname === FRONT_PREFIX || url.pathname.startsWith(`${FRONT_PREFIX}/`)) {
      url.pathname = PROXY_BASE_PATH + url.pathname.slice(FRONT_PREFIX.length);
    }
    return new Request(url, {
      headers: request.headers,
      method: request.method,
      signal: request.signal,
      ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
    } as RequestInit);
  }

  async #withTicketPrefix(response: Response): Promise<Response> {
    // why: the proxy builds the ticket URL from the path it saw, and the client reached it under `/v1`.
    const text = await response.text();
    let body = text;
    try {
      const parsed = JSON.parse(text) as { upload?: { url?: unknown } };
      if (typeof parsed.upload?.url === "string") {
        const ticket = new URL(parsed.upload.url);
        ticket.pathname = `/v1${ticket.pathname}`;
        parsed.upload.url = ticket.toString();
        body = JSON.stringify(parsed);
      }
    } catch {
      body = text;
    }
    return new Response(body, {
      headers: stripBodyHeaders(response.headers),
      status: response.status,
    });
  }
}

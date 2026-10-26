import { randomUUID } from "node:crypto";

import type { Identity } from "../../auth/index.js";
import type { AgentDevicePlatform } from "./agent-device-supervisor.js";
import { FRONT_PREFIX, PROXY_BASE_PATH } from "../shared/paths.js";
import { frontReply, refusal } from "../shared/replies.js";
import { recordingFetch, ReleaseScopeRecord } from "./lease-end.js";
import type { AgentDeviceUpstream } from "./upstream.js";

type ProxyModule = typeof import("@agent-device/proxy");
type DaemonProxy = ReturnType<ProxyModule["createDaemonProxy"]>;

// why: the proxy hands `authenticate` a copy of the request, so the tag travels as a header the front always overwrites.
const TAG_HEADER = "x-simlock-front-tag";
const PREFLIGHT_PATH = `${PROXY_BASE_PATH}/upload/preflight`;

export type HostStatus =
  | {
      readonly state: "running";
      readonly leaseMaxTtlMs: number;
      readonly platforms: readonly AgentDevicePlatform[];
    }
  | { readonly state: "unavailable"; readonly reason: string };

function stripBodyHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete("content-length");
  copy.delete("content-encoding");
  return copy;
}

const DOWNLOAD_LIMIT = 2_147_483_648;

function tooLarge(size: number): Response {
  return frontReply(
    refusal(
      `the download is ${String(size)} bytes; simlock carries downloads up to 2 GB (${String(DOWNLOAD_LIMIT)} bytes)`,
      413,
    ),
    undefined,
  );
}

// why: only a plain decimal is trusted as a size; anything else is counted as absent and the body is counted instead.
function declaredLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

function capped(response: Response): Response {
  const body = response.body;
  if (body === null) return response;
  const declared = declaredLength(response);
  if (declared !== undefined && declared > DOWNLOAD_LIMIT) {
    void body.cancel().catch(() => undefined);
    return tooLarge(declared);
  }
  const reader = body.getReader();
  let seen = 0;
  // why: highWaterMark 0 pulls from the worker only as fast as the agent reads, so nothing is buffered past the cap.
  const counted = new ReadableStream<Uint8Array>(
    {
      cancel: (reason) => reader.cancel(reason),
      pull: async (controller) => {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        seen += next.value.length;
        if (seen > DOWNLOAD_LIMIT) {
          void reader.cancel().catch(() => undefined);
          controller.error(new Error("the download passed 2 GB (2147483648 bytes)"));
          return;
        }
        controller.enqueue(next.value);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(counted, { headers: response.headers, status: response.status });
}

export class AgentDeviceHost {
  readonly #identities = new Map<string, Identity>();
  #loading: Promise<ProxyModule | undefined> | undefined;
  #loadError: string | undefined;
  #proxy: { readonly generation: number; readonly proxy: DaemonProxy } | undefined;

  readonly #upstreamFetch: (request: Request) => Promise<Response>;

  constructor(
    readonly upstream: AgentDeviceUpstream,
    readonly platforms: readonly AgentDevicePlatform[],
    record: ReleaseScopeRecord = new ReleaseScopeRecord(),
  ) {
    this.#upstreamFetch = recordingFetch(upstream, record);
    // why: the gateway's first status.get reads this host's status, and must not pay for the proxy module's load.
    void this.#load();
  }

  async status(): Promise<HostStatus> {
    const current = this.upstream.current();
    if (current.state === "unavailable") return current;
    await this.#load();
    if (this.#loadError !== undefined) return { reason: this.#loadError, state: "unavailable" };
    return {
      leaseMaxTtlMs: current.leaseMaxTtlMs,
      platforms: this.platforms,
      state: "running",
    };
  }

  tag(request: Request, identity: Identity): string {
    const tag = randomUUID();
    this.#identities.set(tag, identity);
    request.headers.set(TAG_HEADER, tag);
    return tag;
  }

  authenticate(request: Request): { readonly tenantId: string } | null {
    const tag = request.headers.get(TAG_HEADER);
    const identity = tag === null ? undefined : this.#identities.get(tag);
    return identity === undefined ? null : { tenantId: identity.principal };
  }

  // fallow-ignore-next-line unused-class-member -- RoutedHostLink calls it as this.hosts[role].forward, a computed key Fallow does not follow.
  async forward(request: Request, identity: Identity): Promise<Response> {
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
      if (new URL(proxied.url).pathname === PREFLIGHT_PATH) {
        return await this.#withTicketPrefix(response);
      }
      return capped(response);
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

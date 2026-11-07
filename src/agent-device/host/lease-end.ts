import type { EndedLease, LeaseEndParticipant } from "../../leasing/index.js";
import type { Filesystem } from "../../ports/index.js";
import { readReleaseScope, type ReleaseScope } from "../shared/release-scope.js";
import {
  classifyCall,
  type CallClass,
  commandLeaseId,
  leaseIdOf,
  readReply,
  readRpcBody,
  replyData,
} from "../shared/rpc.js";
import type { AgentDeviceUpstream } from "./upstream.js";

// why: the ids of ended leases are remembered so a late reply writes nothing; the cap keeps that memory bounded.
const MAX_ENDED_IDS = 4096;
// why: the session names come from the wire, so a lease remembers a bounded number of them.
const MAX_SESSION_NAMES = 64;
// why: a name becomes part of a folder name, so only a plain one is trusted; anything with a separator is left alone.
const FOLDER_PART = /^[A-Za-z0-9._-]+$/;

interface Served {
  readonly tenantId: string;
  readonly sessions: Set<string>;
}

export class ReleaseScopeRecord {
  readonly #scopes = new Map<string, ReleaseScope>();
  readonly #allocating = new Map<string, Promise<ReleaseScope | undefined>>();
  readonly #releasing = new Map<string, Promise<boolean>>();
  readonly #ended = new Set<string>();
  readonly #served = new Map<string, Served>();

  // why: the lease end needs the tenant and the `--session` names to find the folders agent-device made, and only a call through this daemon names them.
  serve(leaseId: string, tenantId: string, session: string | undefined): void {
    if (this.#ended.has(leaseId)) return;
    const served = this.#served.get(leaseId) ?? { sessions: new Set<string>(), tenantId };
    this.#served.set(leaseId, served);
    if (session !== undefined && served.sessions.size < MAX_SESSION_NAMES) {
      served.sessions.add(session);
    }
  }

  folderNames(leaseId: string): readonly string[] {
    const served = this.#served.get(leaseId);
    if (served === undefined) return [];
    return [
      leaseId,
      ...[leaseId, ...served.sessions].map((name) => `${served.tenantId}_${name}`),
    ].filter((name) => FOLDER_PART.test(name));
  }

  get(leaseId: string): ReleaseScope | undefined {
    return this.#scopes.get(leaseId);
  }

  // fallow-ignore-next-line unused-class-member -- called by the participant in this file.
  allocating(leaseId: string): Promise<ReleaseScope | undefined> | undefined {
    return this.#allocating.get(leaseId);
  }

  // fallow-ignore-next-line unused-class-member -- called by the participant in this file.
  releasing(leaseId: string): Promise<boolean> | undefined {
    return this.#releasing.get(leaseId);
  }

  async trackAllocate(leaseId: string, reply: Promise<Response>): Promise<Response> {
    const scope = reply.then(
      async (response) => {
        const text = await response.clone().text();
        const reading = readReply(text, "allocate");
        const read =
          reading.kind === "success"
            ? readReleaseScope(replyData(reading.result)?.["lease"])
            : undefined;
        if (read !== undefined && !this.#ended.has(leaseId)) this.#scopes.set(leaseId, read);
        return read;
      },
      () => undefined,
    );
    this.#allocating.set(leaseId, scope);
    try {
      await scope;
    } finally {
      if (this.#allocating.get(leaseId) === scope) this.#allocating.delete(leaseId);
    }
    return reply;
  }

  async trackRelease(
    leaseId: string,
    reply: Promise<Response>,
    signal: AbortSignal,
  ): Promise<Response> {
    const answered = reply.then(
      async (response) => {
        const text = await response.clone().text();
        const ok = readReply(text).kind === "success" && !signal.aborted;
        if (ok && !this.#ended.has(leaseId)) this.#scopes.delete(leaseId);
        return ok;
      },
      () => false,
    );
    // why: a request its caller hung up on counts as aborted at once, even if the daemon is slow to notice.
    const succeeded = raceAbort(answered, signal).then((outcome) => outcome === true);
    this.#releasing.set(leaseId, succeeded);
    try {
      await succeeded;
    } finally {
      if (this.#releasing.get(leaseId) === succeeded) this.#releasing.delete(leaseId);
    }
    return reply;
  }

  // why: once the participant owns a lease id, a reply arriving later must not bring its entry back.
  // fallow-ignore-next-line unused-class-member -- called by the participant in this file.
  own(leaseId: string): void {
    this.#ended.add(leaseId);
    if (this.#ended.size > MAX_ENDED_IDS) {
      const oldest = this.#ended.values().next().value;
      if (oldest !== undefined) this.#ended.delete(oldest);
    }
  }

  // fallow-ignore-next-line unused-class-member -- called by the participant in this file.
  drop(leaseId: string): void {
    this.#scopes.delete(leaseId);
    this.#served.delete(leaseId);
  }
}

export function recordingFetch(
  upstream: AgentDeviceUpstream,
  record: ReleaseScopeRecord,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const named = await nameCall(request);
    const reply = upstream.fetch(request);
    if (named?.tenantId !== undefined) {
      record.serve(named.leaseId, named.tenantId, named.session);
    }
    if (named?.kind === "allocate") return record.trackAllocate(named.leaseId, reply);
    if (named?.kind === "release") return record.trackRelease(named.leaseId, reply, request.signal);
    return reply;
  };
}

interface NamedCall {
  readonly kind: CallClass;
  readonly leaseId: string;
  readonly tenantId: string | undefined;
  readonly session: string | undefined;
}

async function nameCall(request: Request): Promise<NamedCall | undefined> {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/rpc")) {
    return undefined;
  }
  const read = await readRpcBody(request.clone());
  if (read.kind !== "request") return undefined;
  const kind = classifyCall(read.method, read.params);
  const leaseId = leaseIdOf(read.params["leaseId"]) ?? commandLeaseId(read.params);
  if (leaseId === undefined) return undefined;
  const tenantId = read.params["tenantId"];
  const session = read.params["session"];
  return {
    kind,
    leaseId,
    session: kind === "command" && typeof session === "string" ? session : undefined,
    tenantId: typeof tenantId === "string" ? tenantId : undefined,
  };
}

const ABORTED = Symbol("aborted");

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export interface SessionFolders {
  readonly filesystem: Filesystem;
  // why: the daemon's `sessions` folder, where agent-device makes one folder per session address and removes none.
  readonly directory: string;
}

export class AgentDeviceLeaseEnd implements LeaseEndParticipant {
  constructor(
    readonly upstream: AgentDeviceUpstream,
    readonly record: ReleaseScopeRecord,
    readonly folders: SessionFolders,
  ) {}

  async leaseEnded(ended: EndedLease, signal: AbortSignal): Promise<void> {
    const { leaseId } = ended;
    this.record.own(leaseId);
    try {
      await this.#end(leaseId, signal);
    } finally {
      try {
        await this.#removeFolders(leaseId);
      } finally {
        this.record.drop(leaseId);
      }
    }
  }

  async #removeFolders(leaseId: string): Promise<void> {
    const { directory, filesystem } = this.folders;
    await Promise.all(
      this.record.folderNames(leaseId).map((name) => filesystem.rm(`${directory}/${name}`)),
    );
  }

  async #end(leaseId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const scope = await this.#scopeOf(leaseId, signal);
    if (scope === undefined) return;
    if (this.upstream.current().state !== "running") return;
    const releasing = this.record.releasing(leaseId);
    if (releasing !== undefined) {
      const outcome = await raceAbort(releasing, signal);
      if (outcome === ABORTED || outcome) return;
    }
    await this.#release(leaseId, scope, signal);
  }

  async #scopeOf(leaseId: string, signal: AbortSignal): Promise<ReleaseScope | undefined> {
    const allocating = this.record.allocating(leaseId);
    const allocated = allocating === undefined ? undefined : await raceAbort(allocating, signal);
    return allocated === ABORTED ? undefined : (allocated ?? this.record.get(leaseId));
  }

  async #release(leaseId: string, scope: ReleaseScope, signal: AbortSignal): Promise<void> {
    const current = this.upstream.current();
    if (current.state !== "running") return;
    let text: string;
    try {
      const response = await this.upstream.fetch(
        new Request(`${current.baseUrl}/rpc`, {
          body: JSON.stringify({
            id: "simlock-lease-end",
            jsonrpc: "2.0",
            method: "agent_device.lease.release",
            params: { ...scope, leaseId },
          }),
          headers: {
            authorization: `Bearer ${current.token}`,
            "content-type": "application/json",
            "x-agent-device-tenant": scope.tenantId,
          },
          method: "POST",
          signal,
        }),
      );
      text = await response.text();
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    const reading = readReply(text);
    if (reading.kind === "success") return;
    throw new Error(
      reading.kind === "error"
        ? `agent-device refused the lease release: ${reading.code ?? "no code"}`
        : "agent-device did not answer the lease release",
    );
  }
}

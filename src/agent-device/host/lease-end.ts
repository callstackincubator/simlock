import type { EndedLease, LeaseEndParticipant } from "../../leasing/index.js";
import { readReleaseScope, type ReleaseScope } from "../shared/release-scope.js";
import { classifyCall, leaseIdOf, readReply, readRpcBody, replyData } from "../shared/rpc.js";
import type { AgentDeviceUpstream } from "./upstream.js";

// why: the ids of ended leases are remembered so a late reply writes nothing; the cap keeps that memory bounded.
const MAX_ENDED_IDS = 4096;

export class ReleaseScopeRecord {
  readonly #scopes = new Map<string, ReleaseScope>();
  readonly #allocating = new Map<string, Promise<ReleaseScope | undefined>>();
  readonly #releasing = new Map<string, Promise<boolean>>();
  readonly #ended = new Set<string>();

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
  }
}

export function recordingFetch(
  upstream: AgentDeviceUpstream,
  record: ReleaseScopeRecord,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const named = await nameCall(request);
    const reply = upstream.fetch(request);
    if (named?.kind === "allocate") return record.trackAllocate(named.leaseId, reply);
    if (named?.kind === "release") return record.trackRelease(named.leaseId, reply, request.signal);
    return reply;
  };
}

async function nameCall(
  request: Request,
): Promise<{ readonly kind: "allocate" | "release"; readonly leaseId: string } | undefined> {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/rpc")) {
    return undefined;
  }
  const read = await readRpcBody(request.clone());
  if (read.kind !== "request") return undefined;
  const kind = classifyCall(read.method, read.params);
  const leaseId = leaseIdOf(read.params["leaseId"]);
  return (kind === "allocate" || kind === "release") && leaseId !== undefined
    ? { kind, leaseId }
    : undefined;
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

export class AgentDeviceLeaseEnd implements LeaseEndParticipant {
  constructor(
    readonly upstream: AgentDeviceUpstream,
    readonly record: ReleaseScopeRecord,
  ) {}

  async leaseEnded(ended: EndedLease, signal: AbortSignal): Promise<void> {
    const { leaseId } = ended;
    this.record.own(leaseId);
    try {
      await this.#end(leaseId, signal);
    } finally {
      this.record.drop(leaseId);
    }
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

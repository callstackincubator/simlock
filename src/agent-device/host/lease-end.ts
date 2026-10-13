import type { EndedLease, LeaseEndParticipant } from "../../leasing/index.js";
import type { ReleaseScope } from "../shared/release-scope.js";
import type { AgentDeviceUpstream } from "./upstream.js";

export class ReleaseScopeRecord {
  readonly #scopes = new Map<string, ReleaseScope>();

  get(leaseId: string): ReleaseScope | undefined {
    return this.#scopes.get(leaseId);
  }
}

export function recordingFetch(
  upstream: AgentDeviceUpstream,
  _record: ReleaseScopeRecord,
): (request: Request) => Promise<Response> {
  return (request) => upstream.fetch(request);
}

export class AgentDeviceLeaseEnd implements LeaseEndParticipant {
  constructor(
    readonly upstream: AgentDeviceUpstream,
    readonly record: ReleaseScopeRecord,
  ) {}

  async leaseEnded(_ended: EndedLease, _signal: AbortSignal): Promise<void> {
    return undefined;
  }
}

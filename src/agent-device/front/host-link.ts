import type { TokenIdentity } from "../../http/token-store.js";
import type { AgentDevicePlatform } from "../host/agent-device-supervisor.js";
import type { AgentDeviceHost } from "../host/host.js";

export type LinkStatus =
  | {
      readonly state: "running";
      // why: a link that serves many hosts names the ceiling only for a lease it can place; the front reads it from `status(leaseId)`.
      readonly leaseMaxTtlMs?: number;
      readonly platforms: readonly AgentDevicePlatform[];
    }
  | { readonly state: "unavailable"; readonly reason: string };

export interface HostLink {
  // why: only a link that serves many hosts routes non-RPC requests by the lease header and fans out `devices`; a worker never reads the header.
  readonly readsLeaseHeader: boolean;
  // why: capabilities a lease request must require so it lands on a host that can serve agent-device; none means any worker.
  readonly leaseRequires?: readonly string[];
  status(leaseId?: string, identity?: TokenIdentity): Promise<LinkStatus>;
  forward(request: Request, identity: TokenIdentity, leaseId?: string): Promise<Response>;
  dispose?(): void;
}

export class InProcessHostLink implements HostLink {
  readonly readsLeaseHeader = false;

  constructor(private readonly host: AgentDeviceHost) {}

  status(): ReturnType<HostLink["status"]> {
    return this.host.status();
  }

  forward(request: Request, identity: TokenIdentity): Promise<Response> {
    return this.host.forward(request, identity);
  }
}

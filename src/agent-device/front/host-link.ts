import type { Identity } from "../../auth/index.js";
import type { AgentDevicePlatform } from "../host/agent-device-supervisor.js";
import type { AgentDeviceHost } from "../host/host.js";

export type LinkStatus =
  | {
      readonly state: "running";
      // why: a link that serves many hosts names the ceiling only for a lease it can place; the front reads it from `status(leaseId)`.
      readonly leaseMaxTtlMs?: number;
      readonly platforms: readonly AgentDevicePlatform[];
    }
  | { readonly state: "unavailable"; readonly reason: string }
  // why: the lease may still exist, but only its worker can say, and the worker is not connected or not yet read.
  | { readonly state: "unreachable" };

// why: a lease the front may rebuild an entry for after a gateway restart, with what the entry needs.
export interface AdoptableLease {
  readonly leaseId: string;
  readonly address: string;
  readonly platform: "ios" | "android";
  readonly model: string;
  readonly target: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
}

export interface HostLink {
  // why: only a link that serves many hosts routes non-RPC requests by the lease header and fans out `devices`; a worker never reads the header.
  readonly readsLeaseHeader: boolean;
  // why: capabilities a lease request must require so it lands on a host that can serve agent-device; none means any worker.
  readonly leaseRequires?: readonly string[];
  status(leaseId?: string, identity?: Identity): Promise<LinkStatus>;
  forward(request: Request, identity: Identity, leaseId?: string): Promise<Response>;
  // why: only a link that serves many hosts adopts leases made before the front's map was empty; a worker's map is in memory and has no entry for a lease it made before a restart, but that lease is ended, not adopted.
  adoptable?(identity: Identity): readonly AdoptableLease[];
  // why: a lease the front asked for in this process is its allocate's to keep or release, never to adopt.
  asked?(leaseId: string): void;
  dispose?(): void;
}

export class InProcessHostLink implements HostLink {
  readonly readsLeaseHeader = false;

  constructor(private readonly host: AgentDeviceHost) {}

  status(): ReturnType<HostLink["status"]> {
    return this.host.status();
  }

  forward(request: Request, identity: Identity): Promise<Response> {
    return this.host.forward(request, identity);
  }
}

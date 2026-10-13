import type { TokenIdentity } from "../../http/token-store.js";
import type { Clock, TimerHandle } from "../../ports/index.js";
import type { AgentDevicePlatform } from "../host/agent-device-supervisor.js";
import { agentDeviceLeaseMaxTtlMs } from "../shared/daemon-environment.js";
import { FRONT_PREFIX } from "../shared/paths.js";
import { frontReplyFor, refusal } from "../shared/replies.js";
import type { HostLink, LinkStatus } from "./host-link.js";

export interface FleetWorker {
  readonly id: string;
  readonly platforms: readonly AgentDevicePlatform[];
  readonly leaseMaxTtlMs: number;
}

export interface PlacedLease {
  readonly workerId: string;
  readonly ownerId: string;
}

// why: the edge imports nothing from the gateway, so the gateway's parts reach the link only through this port, built where the gateway is composed.
export interface FleetPort {
  readonly instanceId: string;
  leaseOf(leaseId: string): PlacedLease | undefined;
  // why: connected, not drained, agent-device available, catalog read and `lease.maxTtlMs` known.
  capableWorkers(): readonly FleetWorker[];
  // why: a drained worker keeps serving the leases it holds, so a lease's holder is judged without the drain flag.
  holder(workerId: string): FleetWorker | undefined;
  relay(workerId: string, request: Request, tenant: string, leaseId?: string): Promise<Response>;
  onLeaseRemoved(listener: (lease: PlacedLease & { readonly leaseId: string }) => void): void;
}

export interface RelayHostLinkOptions {
  readonly fleet: FleetPort;
  readonly clock: Clock;
  // why: the gateway's own `lease.maxTtlMs`, the longest a lease it granted can live, bounds how long the link still routes a lease its index dropped.
  readonly leaseMaxTtlMs: number;
}

const NO_WORKER = "no worker connected to this gateway can serve agent-device";
const HOLDER_CANNOT = "the worker holding this lease cannot serve agent-device";
const TOO_OLD = "refused: this agent-device is too old to use through a gateway; update it";
const TOKEN_TOO_LONG = "refused: this token cannot be used through a gateway";
// why: #514's relay refuses a tenant over 300 characters.
const MAX_TENANT_CHARS = 300;
const SWEEP_MS = 60_000;
const FORBIDDEN = 403;

interface Kept extends PlacedLease {
  readonly since: number;
}

function notYours(leaseId: string): string {
  return `refused: lease ${leaseId} is not one of yours on this gateway`;
}

function refuseRequest(request: Request, message: string, status?: number): Promise<Response> {
  return frontReplyFor(request, refusal(message, status));
}

export class RelayHostLink implements HostLink {
  readonly leaseRequires: readonly string[] = ["agent-device"];
  readonly #kept = new Map<string, Kept>();
  #sweep: TimerHandle | undefined;
  #disposed = false;

  constructor(private readonly options: RelayHostLinkOptions) {
    options.fleet.onLeaseRemoved((lease) => this.#keep(lease));
  }

  status(leaseId?: string, identity?: TokenIdentity): Promise<LinkStatus> {
    if (leaseId !== undefined && identity !== undefined) {
      const placed = this.#place(leaseId);
      if (placed?.ownerId === identity.requesterId) {
        const holder = this.options.fleet.holder(placed.workerId);
        return Promise.resolve(
          holder === undefined
            ? { reason: HOLDER_CANNOT, state: "unavailable" }
            : {
                leaseMaxTtlMs: agentDeviceLeaseMaxTtlMs(holder.leaseMaxTtlMs),
                platforms: holder.platforms,
                state: "running",
              },
        );
      }
    }
    return Promise.resolve(this.#anyStatus());
  }

  async forward(request: Request, identity: TokenIdentity, leaseId?: string): Promise<Response> {
    const tenant = `gw:${this.options.fleet.instanceId}:${identity.requesterId}`;
    if (tenant.length > MAX_TENANT_CHARS) return refuseRequest(request, TOKEN_TOO_LONG);
    if (leaseId === undefined) return this.#forwardBare(request, tenant);
    const placed = this.#place(leaseId);
    if (placed === undefined || placed.ownerId !== identity.requesterId) {
      return refuseRequest(request, notYours(leaseId), FORBIDDEN);
    }
    return this.options.fleet.relay(placed.workerId, request, tenant, leaseId);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#sweep !== undefined) this.options.clock.cancel(this.#sweep);
    this.#sweep = undefined;
    this.#kept.clear();
  }

  #anyStatus(): LinkStatus {
    const capable = this.options.fleet.capableWorkers();
    if (capable.length === 0) return { reason: NO_WORKER, state: "unavailable" };
    const platforms = new Set(capable.flatMap((worker) => worker.platforms));
    return { platforms: [...platforms], state: "running" };
  }

  async #forwardBare(request: Request, tenant: string): Promise<Response> {
    const path = new URL(request.url).pathname.slice(FRONT_PREFIX.length);
    if (request.method !== "GET" || path !== "/health") return refuseRequest(request, TOO_OLD);
    const worker = this.options.fleet.capableWorkers()[0];
    if (worker === undefined) throw new Error(NO_WORKER);
    return this.options.fleet.relay(worker.id, request, tenant);
  }

  #place(leaseId: string): PlacedLease | undefined {
    this.#expire();
    return this.options.fleet.leaseOf(leaseId) ?? this.#kept.get(leaseId);
  }

  #keep(lease: PlacedLease & { readonly leaseId: string }): void {
    if (this.#disposed) return;
    this.#kept.set(lease.leaseId, {
      ownerId: lease.ownerId,
      since: this.options.clock.now(),
      workerId: lease.workerId,
    });
    this.#armSweep();
  }

  #expire(): void {
    const now = this.options.clock.now();
    for (const [leaseId, kept] of this.#kept) {
      if (now - kept.since > this.options.leaseMaxTtlMs) this.#kept.delete(leaseId);
    }
  }

  #armSweep(): void {
    if (this.#sweep !== undefined) return;
    this.#sweep = this.options.clock.setTimer(SWEEP_MS, () => {
      this.#sweep = undefined;
      this.#expire();
      if (this.#kept.size > 0 && !this.#disposed) this.#armSweep();
    });
  }
}

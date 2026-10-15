import { createHash } from "node:crypto";

import type { TokenIdentity } from "../../http/token-store.js";
import type { Clock, TimerHandle } from "../../ports/index.js";
import type { AgentDevicePlatform } from "../host/agent-device-supervisor.js";
import { agentDeviceLeaseMaxTtlMs } from "../shared/daemon-environment.js";
import { FRONT_PREFIX } from "../shared/paths.js";
import {
  frontReplyFor,
  markUnreachableAnswer,
  refusal,
  workerUnreachable,
} from "../shared/replies.js";
import type { AdoptableLease, HostLink, LinkStatus } from "./host-link.js";

export interface FleetWorker {
  readonly id: string;
  readonly platforms: readonly AgentDevicePlatform[];
  readonly leaseMaxTtlMs: number;
}

export interface PlacedLease {
  readonly workerId: string;
  readonly ownerId: string;
}

// why: a lease the index holds for a principal, with what the view of its worker says.
export interface FleetLeaseFacts {
  readonly leaseId: string;
  readonly requesterId: string;
  readonly workerId: string;
  readonly connected: boolean;
  // why: true once the worker's view was read since it connected.
  readonly refreshed: boolean;
  // why: present only when the view lists the lease and its device.
  readonly listed?: {
    readonly address: string;
    readonly platform: "ios" | "android";
    readonly model: string;
    readonly deviceClass?: string;
    readonly ttlMs: number;
    readonly ttlDeadline: number;
  };
}

// why: the edge imports nothing from the gateway, so the gateway's parts reach the link only through this port, built in `gateway.ts` from the gateway context.
export interface FleetPort {
  readonly instanceId: string;
  // why: when this gateway process started, which opens the window in which a lease it cannot place may still come back.
  readonly startedAt: number;
  leaseOf(leaseId: string): PlacedLease | undefined;
  // why: connected, not drained, agent-device available, catalog read and `lease.maxTtlMs` known.
  capableWorkers(): readonly FleetWorker[];
  // why: a drained worker keeps serving the leases it holds, so a lease's holder is judged without the drain flag.
  holder(workerId: string): FleetWorker | undefined;
  // why: whether the lease's worker is connected and read; undefined for a worker the gateway has no view of.
  reach(workerId: string): { readonly connected: boolean; readonly refreshed: boolean } | undefined;
  leasesOf(ownerId: string): readonly FleetLeaseFacts[];
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
// why: agent-device accepts a tenant of 1 to 128 letters, digits, dots, underscores and hyphens.
const MAX_TENANT_CHARS = 128;
const HASH_CHARS = 27;
const SWEEP_MS = 60_000;
// why: after a restart the workers reconnect within this long; until then a lease the index lacks may still be one of theirs.
const START_WINDOW_MS = 60_000;
const WORKER_UNREACHABLE = "WORKER_UNREACHABLE";
const TARGET_OF_CLASS: Record<string, string> = { desktop: "desktop", tv: "tv" };
const FORBIDDEN = 403;

// why: a character agent-device refuses (or a dot, the separator) becomes `_<hex>_`, so two names never share a tenant.
function tenantPart(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/gu, (char) => `_${char.codePointAt(0)?.toString(16)}_`);
}

// why: `gw.<gateway instance id>.<principal>`, cut to 128 characters with a hash of the whole name when longer, so every input gives a tenant agent-device accepts and distinct inputs stay distinct.
function relayTenant(instanceId: string, principal: string): string {
  const tenant = `gw.${tenantPart(instanceId)}.${tenantPart(principal)}`;
  if (tenant.length <= MAX_TENANT_CHARS) return tenant;
  const hash = createHash("sha256")
    .update(JSON.stringify([instanceId, principal]))
    .digest("hex");
  return `${tenant.slice(0, MAX_TENANT_CHARS - HASH_CHARS - 1)}.${hash.slice(0, HASH_CHARS)}`;
}

const UNREACHABLE: LinkStatus = { state: "unreachable" };

function isRpcCall(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname === `${FRONT_PREFIX}/rpc`;
}

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
  readonly readsLeaseHeader = true;
  readonly #kept = new Map<string, Kept>();
  readonly #asked = new Set<string>();
  #sweep: TimerHandle | undefined;
  #disposed = false;

  constructor(private readonly options: RelayHostLinkOptions) {
    options.fleet.onLeaseRemoved((lease) => {
      this.#asked.delete(lease.leaseId);
      this.#keep(lease);
    });
  }

  status(leaseId?: string, identity?: TokenIdentity): Promise<LinkStatus> {
    if (leaseId === undefined || identity === undefined) return Promise.resolve(this.#anyStatus());
    const placed = this.#place(leaseId);
    if (placed === undefined && this.#inStartWindow()) return Promise.resolve(UNREACHABLE);
    if (placed?.ownerId !== identity.requesterId) return Promise.resolve(this.#anyStatus());
    return Promise.resolve(this.#holderStatus(placed));
  }

  async forward(request: Request, identity: TokenIdentity, leaseId?: string): Promise<Response> {
    const tenant = relayTenant(this.options.fleet.instanceId, identity.requesterId);
    if (leaseId === undefined) return this.#forwardBare(request, tenant);
    const placed = this.#place(leaseId);
    if (placed === undefined || placed.ownerId !== identity.requesterId) {
      return refuseRequest(request, notYours(leaseId), FORBIDDEN);
    }
    return this.#relay(placed.workerId, request, tenant, leaseId);
  }

  asked(leaseId: string): void {
    this.#asked.add(leaseId);
  }

  adoptable(identity: TokenIdentity): readonly AdoptableLease[] {
    return this.options.fleet.leasesOf(identity.requesterId).flatMap((facts) => {
      const { listed } = facts;
      if (
        facts.requesterId !== facts.leaseId ||
        this.#asked.has(facts.leaseId) ||
        !facts.connected ||
        !facts.refreshed ||
        listed === undefined
      ) {
        return [];
      }
      return [
        {
          address: listed.address,
          leaseId: facts.leaseId,
          model: listed.model,
          platform: listed.platform,
          target: TARGET_OF_CLASS[listed.deviceClass ?? ""] ?? "mobile",
          ttlDeadline: listed.ttlDeadline,
          ttlMs: listed.ttlMs,
        },
      ];
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#sweep !== undefined) this.options.clock.cancel(this.#sweep);
    this.#sweep = undefined;
    this.#kept.clear();
    this.#asked.clear();
  }

  #holderStatus(placed: PlacedLease): LinkStatus {
    const reach = this.options.fleet.reach(placed.workerId);
    if (reach !== undefined && !(reach.connected && reach.refreshed)) return UNREACHABLE;
    const holder = this.options.fleet.holder(placed.workerId);
    if (holder === undefined) return { reason: HOLDER_CANNOT, state: "unavailable" };
    return {
      leaseMaxTtlMs: agentDeviceLeaseMaxTtlMs(holder.leaseMaxTtlMs),
      platforms: holder.platforms,
      state: "running",
    };
  }

  #inStartWindow(): boolean {
    return this.options.clock.now() - this.options.fleet.startedAt < START_WINDOW_MS;
  }

  // why: the relay fails with WORKER_UNREACHABLE when the uplink drops mid-call, and this link is the one place that names that to the agent.
  async #relay(
    workerId: string,
    request: Request,
    tenant: string,
    leaseId?: string,
  ): Promise<Response> {
    const asked = isRpcCall(request) ? request.clone() : request;
    try {
      return await this.options.fleet.relay(workerId, request, tenant, leaseId);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== WORKER_UNREACHABLE) throw error;
      return markUnreachableAnswer(await frontReplyFor(asked, workerUnreachable()));
    }
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

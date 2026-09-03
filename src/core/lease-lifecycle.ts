import type { EventBus } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import type { DeviceRecord, LeaseRecord } from "./domain.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import type { ReleasedLease } from "./registry.js";

export interface LeaseLifecycleRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
  createLease(input: {
    readonly deviceId: string;
    readonly requesterId: string;
    readonly ownerId: string;
    readonly mode: LeaseRecord["mode"];
    readonly ttlDeadline: number;
  }): Promise<LeaseRecord>;
  renewLease(leaseId: string, ttlDeadline: number): Promise<LeaseRecord>;
  beginRelease(leaseId: string): Promise<ReleasedLease>;
}

export interface LeaseLifecycleOptions {
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly expiryScheduler: LeaseExpiryScheduler;
  readonly registry: LeaseLifecycleRegistry;
  readonly ttl: { readonly detachedMs: number; readonly heldBackstopMs: number };
}

export interface LeaseLifecycleGrant {
  readonly device: DeviceRecord;
  readonly lease: LeaseRecord;
}

/** A heartbeat slides to the *held* backstop, so it must never be applied to a detached lease. */
export class DetachedLeaseHeartbeatError extends Error {
  constructor(readonly leaseId: string) {
    super(`Detached lease cannot be heartbeated: ${leaseId}`);
    this.name = "DetachedLeaseHeartbeatError";
  }
}

/** Registry-backed lease state changes, deliberately excluding reclaiming and queue wakeups. */
export class LeaseLifecycle {
  constructor(private readonly options: LeaseLifecycleOptions) {}

  // fallow-ignore-next-line unused-class-member -- reached through LeaseAcquisitionCoordinator's leases port.
  async grant(input: {
    readonly deviceId: string;
    readonly mode: LeaseRecord["mode"];
    readonly ownerId: string;
    readonly requesterId: string;
    /** ADR 0003 §9: overrides the mode-aware default for a detached lease's initial TTL. */
    readonly ttlMs?: number;
  }): Promise<LeaseLifecycleGrant> {
    const { ttlMs, ...createInput } = input;
    const lease = await this.options.registry.createLease({
      ...createInput,
      ttlDeadline: this.options.clock.now() + (ttlMs ?? this.#ttlFor(input.mode)),
    });
    const device = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === lease.deviceId,
    );
    if (device === undefined)
      throw new Error(`Granted device disappeared from registry: ${lease.deviceId}`);

    this.options.eventBus.emit(
      "lease.granted",
      {
        deviceId: lease.deviceId,
        leaseId: lease.id,
        mode: lease.mode,
        requester: lease.requesterId,
      },
      "lease-lifecycle",
    );
    this.options.expiryScheduler.arm(lease);
    return { device, lease };
  }

  // fallow-ignore-next-line unused-class-member -- reached through LeaseReleaseCoordinator's lifecycle port.
  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
    const effectiveTtlMs = ttlMs ?? this.#ttlFor(current?.mode ?? "detached");

    const renewed = await this.options.registry.renewLease(
      leaseId,
      this.options.clock.now() + effectiveTtlMs,
    );
    this.options.eventBus.emit(
      "lease.renewed",
      { leaseId: renewed.id, newDeadline: renewed.ttlDeadline },
      "lease-lifecycle",
    );
    this.options.expiryScheduler.replace(renewed);
    return renewed;
  }

  /**
   * Slides a held lease's deadline back out to a full backstop from now, driven by an
   * application-level heartbeat from its holder. Goes through the registry (not a direct
   * `expiryScheduler.replace`) so the persisted `ttlDeadline` stays truthful for readers within
   * this daemon's lifetime: `status` / `list --leases` derive `lastHeartbeatAt` from it
   * (`DaemonServer#decorateLease`), and a stale in-memory-only slide would make that reading
   * wrong immediately, not just after a restart. It does *not* mean the slid deadline survives
   * a restart -- a held lease's liveness is its daemon connection, so `StartupConverger`
   * releases every held lease as orphaned on startup regardless of how recently it was slid;
   * see `startup-converger.ts`.
   */
  // fallow-ignore-next-line unused-class-member -- called by LeaseReleaseCoordinator through the lifecycle port (same as the sibling renew).
  async heartbeat(leaseId: string): Promise<LeaseRecord> {
    const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
    if (current !== undefined && current.mode !== "held")
      throw new DetachedLeaseHeartbeatError(leaseId);

    const renewed = await this.options.registry.renewLease(
      leaseId,
      this.options.clock.now() + this.options.ttl.heldBackstopMs,
    );
    this.options.eventBus.emit(
      "lease.renewed",
      { leaseId: renewed.id, newDeadline: renewed.ttlDeadline },
      "lease-lifecycle",
    );
    this.options.expiryScheduler.replace(renewed);
    return renewed;
  }

  async beginRelease(
    leaseId: string,
    reason: "closed" | "explicit" | "killed" | "orphaned" | "expired" | "device-lost",
  ): Promise<ReleasedLease> {
    const released = await this.options.registry.beginRelease(leaseId);
    this.options.expiryScheduler.cancel(leaseId);
    if (reason === "expired") {
      this.options.eventBus.emit(
        "lease.expired",
        {
          deviceId: released.lease.deviceId,
          leaseId: released.lease.id,
          ownerId: released.lease.ownerId,
        },
        "lease-lifecycle",
      );
    } else {
      this.options.eventBus.emit(
        "lease.released",
        {
          deviceId: released.lease.deviceId,
          leaseId: released.lease.id,
          ownerId: released.lease.ownerId,
          reason,
        },
        "lease-lifecycle",
      );
    }
    return released;
  }

  restoreExpiryTimers(): Promise<void> {
    return this.options.expiryScheduler.restore(this.options.registry.snapshot.leases);
  }

  #ttlFor(mode: LeaseRecord["mode"]): number {
    return mode === "held" ? this.options.ttl.heldBackstopMs : this.options.ttl.detachedMs;
  }
}

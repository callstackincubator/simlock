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

export class HeldLeaseRenewalError extends Error {
  constructor(readonly leaseId: string) {
    super(`Held lease cannot be renewed: ${leaseId}`);
    this.name = "HeldLeaseRenewalError";
  }
}

/** Registry-backed lease state changes, deliberately excluding reclaiming and queue wakeups. */
export class LeaseLifecycle {
  constructor(private readonly options: LeaseLifecycleOptions) {}

  // fallow-ignore-next-line unused-class-member -- wired into LeaseEngine in the follow-up integration.
  async grant(input: {
    readonly deviceId: string;
    readonly mode: LeaseRecord["mode"];
    readonly requesterId: string;
  }): Promise<LeaseLifecycleGrant> {
    const lease = await this.options.registry.createLease({
      ...input,
      ttlDeadline: this.options.clock.now() + this.#ttlFor(input.mode),
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

  // fallow-ignore-next-line unused-class-member -- wired into LeaseEngine in the follow-up integration.
  async renew(leaseId: string, ttlMs: number): Promise<LeaseRecord> {
    const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
    if (current?.mode === "held") throw new HeldLeaseRenewalError(leaseId);

    const renewed = await this.options.registry.renewLease(
      leaseId,
      this.options.clock.now() + ttlMs,
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
    reason: "closed" | "explicit" | "killed" | "expired",
  ): Promise<ReleasedLease> {
    const released = await this.options.registry.beginRelease(leaseId);
    this.options.expiryScheduler.cancel(leaseId);
    if (reason === "expired") {
      this.options.eventBus.emit(
        "lease.expired",
        { deviceId: released.lease.deviceId, leaseId: released.lease.id },
        "lease-lifecycle",
      );
    } else {
      this.options.eventBus.emit(
        "lease.released",
        { deviceId: released.lease.deviceId, leaseId: released.lease.id, reason },
        "lease-lifecycle",
      );
    }
    return released;
  }

  // fallow-ignore-next-line unused-class-member -- invoked by daemon startup after integration.
  restoreExpiryTimers(): Promise<void> {
    return this.options.expiryScheduler.restore(this.options.registry.snapshot.leases);
  }

  #ttlFor(mode: LeaseRecord["mode"]): number {
    return mode === "held" ? this.options.ttl.heldBackstopMs : this.options.ttl.detachedMs;
  }
}

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
    readonly ttlMs: number;
    readonly ttlDeadline: number;
  }): Promise<LeaseRecord>;
  renewLease(leaseId: string, ttlDeadline: number, ttlMs: number): Promise<LeaseRecord>;
  beginRelease(leaseId: string): Promise<ReleasedLease>;
}

export interface LeaseLifecycleOptions {
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly expiryScheduler: LeaseExpiryScheduler;
  readonly registry: LeaseLifecycleRegistry;
  /**
   * ADR 0004 §4: `defaultMs` is `lease.defaultTtlMs`, and it applies in exactly one place -- a
   * grant whose request named no `ttlMs`. A renew never falls back to it; it re-applies the
   * lease's own stored width instead.
   */
  readonly ttl: { readonly defaultMs: number };
}

export interface LeaseLifecycleGrant {
  readonly device: DeviceRecord;
  readonly lease: LeaseRecord;
}

/** Registry-backed lease state changes, deliberately excluding reclaiming and queue wakeups. */
export class LeaseLifecycle {
  constructor(private readonly options: LeaseLifecycleOptions) {}

  // fallow-ignore-next-line unused-class-member -- reached through LeaseAcquisitionCoordinator's leases port.
  async grant(input: {
    readonly deviceId: string;
    readonly ownerId: string;
    readonly requesterId: string;
    /** ADR 0004 §4: this lease's initial width; `lease.defaultTtlMs` when the request named
     * none. Whatever it resolves to is stored on the record, because that is what a later
     * body-less renew re-applies. */
    readonly ttlMs?: number;
  }): Promise<LeaseLifecycleGrant> {
    const { ttlMs, ...createInput } = input;
    const effectiveTtlMs = ttlMs ?? this.options.ttl.defaultMs;
    const lease = await this.options.registry.createLease({
      ...createInput,
      ttlMs: effectiveTtlMs,
      ttlDeadline: this.options.clock.now() + effectiveTtlMs,
    });
    const device = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === lease.deviceId,
    );
    if (device === undefined)
      throw new Error(`Granted device disappeared from registry: ${lease.deviceId}`);

    // ADR 0004's Consequences: `mode` leaves this payload, a deliberate one-off exception to
    // events rule 6 (additive payloads only) taken while the package is 0.x -- there is no mode
    // left to report. `EVENTS.md` records the exception.
    this.options.eventBus.emit(
      "lease.granted",
      {
        deviceId: lease.deviceId,
        leaseId: lease.id,
        requester: lease.requesterId,
      },
      "lease-lifecycle",
    );
    this.options.expiryScheduler.arm(lease);
    return { device, lease };
  }

  /**
   * The one thing that keeps a lease alive (ADR 0004 §1). An omitted `ttlMs` re-applies the
   * lease's own stored width, never `lease.defaultTtlMs`: a lease granted for four hours keeps
   * its four hours through renewals that do not ask for anything different. A named `ttlMs`
   * changes that width from this renewal on, which is why it is written back to the record.
   * The fallback to `defaultMs` is unreachable for a live lease -- it only covers a lease the
   * snapshot no longer has, whose `renewLease` below is about to throw `UnknownLeaseError`.
   */
  // fallow-ignore-next-line unused-class-member -- reached through LeaseReleaseCoordinator's lifecycle port.
  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
    const effectiveTtlMs = ttlMs ?? current?.ttlMs ?? this.options.ttl.defaultMs;

    const renewed = await this.options.registry.renewLease(
      leaseId,
      this.options.clock.now() + effectiveTtlMs,
      effectiveTtlMs,
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
   * ADR 0004's Consequences: `closed` and `orphaned` are gone from the reasons a lease can end
   * with. Neither concept survives -- a closing connection is not a release (§3), and there is
   * no startup sweep left to orphan anything.
   */
  async beginRelease(
    leaseId: string,
    reason: "explicit" | "killed" | "expired" | "device-lost",
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

  /** Re-arms every persisted lease's TTL timer from its own deadline (ADR 0004: startup
   * restores all of them, and sweeps none -- nothing about a restart proves a holder is
   * dead). */
  restoreExpiryTimers(): Promise<void> {
    return this.options.expiryScheduler.restore(this.options.registry.snapshot.leases);
  }
}

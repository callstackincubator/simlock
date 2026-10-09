import type { EventBus, EventMap } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import {
  type DeviceRecord,
  type LeaseGrant,
  type LeaseRecord,
  type ReleasedLease,
} from "../core/index.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";

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
    readonly leaseId?: string;
    readonly request?: {
      readonly id: string;
      readonly environment: LeaseGrant["environment"];
      readonly timing: LeaseGrant["timing"];
    };
  }): Promise<LeaseRecord>;
  renewLease(leaseId: string, ttlDeadline: number, ttlMs: number): Promise<LeaseRecord>;
  beginRelease(
    leaseId: string,
    options?: { readonly deferReclaim?: boolean },
  ): Promise<ReleasedLease>;
  endLeaseAndMarkDeviceMissing(
    leaseId: string,
    initiator: string,
    announceLeaseEnd: (ended: ReleasedLease) => void,
  ): Promise<ReleasedLease>;
}

type LeaseEndReason = "explicit" | "killed" | "expired" | "device-lost";

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

/** Registry-backed lease state changes, deliberately excluding reclaiming and queue wakeups. */
export class LeaseLifecycle {
  constructor(private readonly options: LeaseLifecycleOptions) {}

  // fallow-ignore-next-line unused-class-member -- reached through LeaseAcquisitionCoordinator's leases port.
  async grant(input: {
    readonly deviceId: string;
    readonly ownerId: string;
    readonly requesterId: string;
    /** The stored request this grant serves, carried on `lease.granted`. */
    readonly requestId: string;
    /**
     * What a repeat of the request answers besides the device and lease: stored with the lease in
     * the one write, so a crash after it cannot leave the request open.
     */
    readonly environment: LeaseGrant["environment"];
    readonly timing: LeaseGrant["timing"];
    /** How the device came to be ready, carried on `lease.granted`. */
    readonly source: EventMap["lease.granted"]["source"];
    /** ADR 0004 §4: this lease's initial width; `lease.defaultTtlMs` when the request named
     * none. Whatever it resolves to is stored on the record, because that is what a later
     * body-less renew re-applies. */
    readonly ttlMs?: number;
    /** ADR 0020: the lease ID the requester chose, when it did. The caller has already refused one
     * that is in use. */
    readonly leaseId?: string;
    /** ADR 0021: the gateway's request id, when the request is a gateway dispatch, carried on
     * `lease.granted`. */
    readonly fleetRequestId?: string;
  }): Promise<LeaseGrant> {
    const { ttlMs, requestId, environment, timing, source, fleetRequestId, ...createInput } = input;
    const effectiveTtlMs = ttlMs ?? this.options.ttl.defaultMs;
    const lease = await this.options.registry.createLease({
      ...createInput,
      request: { environment, id: requestId, timing },
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
        requestId,
        source,
        ...(fleetRequestId === undefined ? {} : { fleetRequestId }),
      },
      "lease-lifecycle",
    );
    this.options.expiryScheduler.arm(lease);
    return { device, environment, lease, timing };
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
    reason: LeaseEndReason,
    options: { readonly deferReclaim?: boolean } = {},
  ): Promise<ReleasedLease> {
    const released = await this.options.registry.beginRelease(leaseId, options);
    this.#announceEnd(released, reason);
    return released;
  }

  /**
   * Ends a lease whose device a daemon start found gone, and marks the device missing in the same
   * write (`device.deleted`, initiator `doctor`). The lease's fact, `lease.expired` for one whose
   * deadline had passed and `lease.released` otherwise, is emitted after the commit and before the
   * device's. Nothing is left `reclaiming`: there is nothing to wipe.
   */
  // fallow-ignore-next-line unused-class-member -- reached through LeaseReleaseCoordinator's lifecycle port.
  async endForMissingDevice(
    leaseId: string,
    reason: "expired" | "device-lost",
  ): Promise<ReleasedLease> {
    return this.options.registry.endLeaseAndMarkDeviceMissing(leaseId, "doctor", (ended) =>
      this.#announceEnd(ended, reason),
    );
  }

  #announceEnd(released: ReleasedLease, reason: LeaseEndReason): void {
    this.options.expiryScheduler.cancel(released.lease.id);
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
  }

  /** Re-arms every remaining lease's TTL timer from its own deadline. Startup runs it after the
   * reconciler has ended the leases whose device is not running (ADR 0019): a restart does not
   * prove a holder is dead, so a lease whose device is running is kept, and one whose deadline
   * passed while no daemon ran expires here. */
  restoreExpiryTimers(): Promise<void> {
    return this.options.expiryScheduler.restore(this.options.registry.snapshot.leases);
  }
}

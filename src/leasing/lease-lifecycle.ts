import type { EventBus, EventMap } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import {
  type AbsentReason,
  type DeviceRecord,
  type LeaseGrant,
  type LeaseRecord,
  type ReleasedLease,
  type DriverCatalog,
  BadDeviceRequestError,
  toDriverDevice,
  UnknownLeaseError,
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
    readonly except?: readonly string[];
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
  endLeaseAndMarkDeviceAbsent(
    leaseId: string,
    absentReason: AbsentReason,
    announceLeaseEnd: (ended: ReleasedLease) => void,
  ): Promise<ReleasedLease>;
}

type LeaseEndReason = "explicit" | "killed" | "expired" | "device-lost";

export class ProviderLeaseDeadlineError extends BadDeviceRequestError {
  constructor(readonly confirmedDeadline: number) {
    super("The device provider could not extend the lease to the requested deadline");
    this.name = "ProviderLeaseDeadlineError";
  }
}

export interface LeaseLifecycleOptions {
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly expiryScheduler: LeaseExpiryScheduler;
  readonly registry: LeaseLifecycleRegistry;
  readonly ttl: { readonly defaultMs: number };
  readonly drivers?: Pick<DriverCatalog, "get">;
}

export class LeaseLifecycle {
  constructor(private readonly options: LeaseLifecycleOptions) {}

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
    /** why: the categories a slim lease keeps running, written to the device in the grant commit (ADR 0066 §4). */
    readonly except?: readonly string[];
    /** ADR 0021: the gateway's request id, when the request is a gateway dispatch, carried on
     * `lease.granted`. */
    readonly fleetRequestId?: string;
  }): Promise<LeaseGrant> {
    const { ttlMs, requestId, environment, timing, source, fleetRequestId, ...createInput } = input;
    const effectiveTtlMs = ttlMs ?? this.options.ttl.defaultMs;
    const ttlDeadline = this.options.clock.now() + effectiveTtlMs;
    this.#checkDeadline(input.deviceId, ttlDeadline);
    const lease = await this.options.registry.createLease({
      ...createInput,
      request: { environment, id: requestId, timing },
      ttlMs: effectiveTtlMs,
      ttlDeadline,
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
        platform: device.spec.platform,
        ...(device.spec.baseline === undefined ? {} : { baseline: device.spec.baseline }),
        ...(fleetRequestId === undefined ? {} : { fleetRequestId }),
      },
      "lease-lifecycle",
    );
    this.options.expiryScheduler.arm(lease);
    return { device, environment, lease, timing };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the LeaseReleaseLifecycle port by the release coordinator.
  async prepareRenewal(leaseId: string, ttlMs?: number): Promise<number> {
    const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
    if (current === undefined) throw new UnknownLeaseError(leaseId);
    const effectiveTtlMs = ttlMs ?? current.ttlMs;
    const requestedDeadline = this.options.clock.now() + effectiveTtlMs;
    const device = this.#device(current.deviceId);
    const driver = this.options.drivers?.get(device.spec.platform);
    if (driver?.renewLease === undefined) {
      this.#checkDeadline(current.deviceId, requestedDeadline);
      return requestedDeadline;
    }
    const target = toDriverDevice(device);
    const confirmedDeadline = await driver.renewLease(target, requestedDeadline);
    if (confirmedDeadline < requestedDeadline) {
      throw new ProviderLeaseDeadlineError(confirmedDeadline);
    }
    return requestedDeadline;
  }

  async renew(leaseId: string, ttlMs?: number, confirmedDeadline?: number): Promise<LeaseRecord> {
    const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
    const effectiveTtlMs = ttlMs ?? current?.ttlMs ?? this.options.ttl.defaultMs;
    const ttlDeadline = confirmedDeadline ?? this.options.clock.now() + effectiveTtlMs;
    if (current !== undefined) this.#checkDeadline(current.deviceId, ttlDeadline);

    const renewed = await this.options.registry.renewLease(leaseId, ttlDeadline, effectiveTtlMs);
    this.options.eventBus.emit(
      "lease.renewed",
      { leaseId: renewed.id, newDeadline: renewed.ttlDeadline },
      "lease-lifecycle",
    );
    this.options.expiryScheduler.replace(renewed);
    return renewed;
  }

  #device(deviceId: string): DeviceRecord {
    const device = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === deviceId,
    );
    if (device === undefined) throw new Error(`Lease device is missing: ${deviceId}`);
    return device;
  }

  #checkDeadline(deviceId: string, ttlDeadline: number): void {
    const device = this.#device(deviceId);
    const driver = this.options.drivers?.get(device.spec.platform);
    const target = toDriverDevice(device);
    const maximum = driver?.maximumLeaseDeadline?.(target);
    if (maximum !== undefined && ttlDeadline > maximum) {
      throw new BadDeviceRequestError(
        "The requested lease exceeds the device provider's remaining lifetime",
      );
    }
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

  /** why: the lease's fact is emitted after the commit and before the device's `device.deleted`. */
  // fallow-ignore-next-line unused-class-member -- reached through LeaseReleaseCoordinator's lifecycle port.
  async endForMissingDevice(
    leaseId: string,
    reason: "expired" | "device-lost",
  ): Promise<ReleasedLease> {
    return this.options.registry.endLeaseAndMarkDeviceMissing(leaseId, "doctor", (ended) =>
      this.#announceEnd(ended, reason),
    );
  }

  // fallow-ignore-next-line unused-class-member -- reached through LeaseReleaseCoordinator's lifecycle port.
  async endForAbsentDevice(leaseId: string, absentReason: AbsentReason): Promise<ReleasedLease> {
    return this.options.registry.endLeaseAndMarkDeviceAbsent(leaseId, absentReason, (ended) =>
      this.#announceEnd(ended, "device-lost"),
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

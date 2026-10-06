import type { EventBus } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import { type DeviceRecord, type LeaseRecord, mayBeGranted, type Platform } from "./domain.js";
import type { Driver, DriverDevice } from "./driver.js";
import type { QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import type { ReleasedLease } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";

export interface ReclaimDriverCatalog {
  get(platform: Platform): Driver;
}

export interface ReclaimRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
  transitionDevice(
    deviceId: string,
    to: "ready" | "shutdown" | "deleted",
    event:
      | {
          readonly event: "device.reclaimed";
          readonly payload: {
            readonly deviceId: string;
            readonly duration: number;
            readonly strategy: "erase" | "snapshot" | "wipe";
          };
        }
      | {
          readonly event: "device.deleted";
          readonly payload: { readonly deviceId: string; readonly initiator: string };
        },
  ): Promise<DeviceRecord>;
  completeReclaimWithoutPurge(deviceId: string): Promise<DeviceRecord>;
}

/** Where a release-time purge failure is handed off once the reclaim attempt commits. */
export interface ReclaimQuarantine {
  enter(failure: QuarantinePurgeFailure): Promise<void>;
}

export interface ReclaimCoordinatorOptions {
  readonly clock: Clock;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: ReclaimDriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly notifyAvailability: () => void;
  readonly quarantine: ReclaimQuarantine;
  readonly registry: ReclaimRegistry;
}

/**
 * Reclaims released devices and commits the state the driver's reclaim returns. Driver
 * work remains outside the serialized registry decision sections.
 */
export class ReclaimCoordinator {
  constructor(private readonly options: ReclaimCoordinatorOptions) {}

  // Not `async`: returning the inner promise adds no microtask hop to a reclaim's start, and
  // the tests that step a fake clock count those hops.
  reclaim(released: ReleasedLease): Promise<void> {
    if (!mayBeGranted(released.device)) return this.#retireSpent(released);
    return this.#purge(released.device, released.lease.id);
  }

  async #purge(device: DeviceRecord, leaseId: string): Promise<void> {
    const driver = this.options.drivers.get(device.spec.platform);
    const startedAt = this.options.clock.now();
    const attemptedStrategy = driver.reclaimStrategy({ clean: "standard" });
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(device), { clean: "standard" });
    } catch (error: unknown) {
      await this.#recoverPurgeFailure(device.id, leaseId, startedAt, attemptedStrategy, error);
      return;
    }

    await this.options.decisions.run(async () => {
      await this.options.registry.transitionDevice(device.id, result.state, {
        event: "device.reclaimed",
        payload: {
          deviceId: device.id,
          duration: this.options.clock.now() - startedAt,
          strategy: result.strategy,
        },
      });
    });
    this.options.notifyAvailability();
  }

  /**
   * Safely finishes an unleased reclaim interrupted before its disposition commit.
   *
   * A reusable device whose wipe a daemon start put off (`deferredReclaimLeaseId`, ADR 0019 §2)
   * gets the full reclaim instead, purge included: it still holds its last holder's data, and a
   * reusable device never returns to the pool with it. A spent fresh device, which is never
   * purged, takes the shutdown path either way.
   */
  async recoverInterrupted(deviceId: string): Promise<boolean> {
    const device = await this.options.decisions.run(async () => {
      const current = this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === deviceId,
      );
      const leased = this.options.registry.snapshot.leases.some(
        (lease) => lease.deviceId === deviceId,
      );
      return current?.state === "reclaiming" && !leased ? current : undefined;
    });
    if (device === undefined) return false;

    if (device.deferredReclaimLeaseId !== undefined && mayBeGranted(device)) {
      await this.#purge(device, device.deferredReclaimLeaseId);
      return true;
    }

    await this.options.drivers.get(device.spec.platform).shutdown(toDriverDevice(device));
    const recovered = await this.options.decisions.run(async () => {
      const current = this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === deviceId,
      );
      const leased = this.options.registry.snapshot.leases.some(
        (lease) => lease.deviceId === deviceId,
      );
      if (current?.state !== "reclaiming" || leased) return false;
      await this.options.registry.completeReclaimWithoutPurge(deviceId);
      this.options.eventBus.emit(
        "device.shutdown",
        { deviceId, initiator: "startup-interrupted-reclaim" },
        "warm-pool-coordinator",
      );
      return true;
    });
    if (recovered) this.options.notifyAvailability();
    return recovered;
  }

  /**
   * Finishes a spent fresh device found `shutdown` at startup: the daemon stopped after its
   * lease-end shutdown committed and before its delete did. A delete that fails throws and
   * leaves the device `shutdown`, where `mayBeGranted` still keeps it out of every grant.
   */
  async deleteSpent(deviceId: string): Promise<boolean> {
    const device = await this.options.decisions.run(async () => {
      const current = this.#unleasedDevice(deviceId, "shutdown");
      return current === undefined || mayBeGranted(current) ? undefined : current;
    });
    if (device === undefined) return false;
    return this.#deleteSpent(device);
  }

  /**
   * A spent fresh device is never purged and never returns to the pool. Its lease end is a
   * driver shutdown, a `reclaiming -> shutdown` commit with no `device.reclaimed` (nothing was
   * reclaimed), then the delete. Either driver step failing hands the device to quarantine,
   * which retries the delete.
   */
  async #retireSpent(released: ReleasedLease): Promise<void> {
    const driver = this.options.drivers.get(released.device.spec.platform);
    const startedAt = this.options.clock.now();
    try {
      await driver.shutdown(toDriverDevice(released.device));
    } catch (error: unknown) {
      await this.#recoverPurgeFailure(
        released.device.id,
        released.lease.id,
        startedAt,
        "delete",
        error,
      );
      return;
    }
    const shutdown = await this.options.decisions.run(() =>
      this.options.registry.completeReclaimWithoutPurge(released.device.id),
    );
    // Running capacity is free from here; the device itself stays ungrantable.
    this.options.notifyAvailability();

    try {
      await this.#deleteSpent(shutdown);
    } catch (error: unknown) {
      await this.#recoverPurgeFailure(
        released.device.id,
        released.lease.id,
        startedAt,
        "delete",
        error,
      );
    }
  }

  /** Destroys a spent device and commits `shutdown -> deleted`, if it is still that device. */
  async #deleteSpent(device: DeviceRecord): Promise<boolean> {
    await this.options.drivers.get(device.spec.platform).destroy(toDriverDevice(device));
    const deleted = await this.options.decisions.run(async () => {
      if (this.#unleasedDevice(device.id, "shutdown") === undefined) return false;
      await this.options.registry.transitionDevice(device.id, "deleted", {
        event: "device.deleted",
        payload: { deviceId: device.id, initiator: "lease-end" },
      });
      return true;
    });
    if (deleted) this.options.notifyAvailability();
    return deleted;
  }

  #unleasedDevice(deviceId: string, state: DeviceRecord["state"]): DeviceRecord | undefined {
    const { devices, leases } = this.options.registry.snapshot;
    const current = devices.find((candidate) => candidate.id === deviceId);
    if (current?.state !== state || leases.some((lease) => lease.deviceId === deviceId)) {
      return undefined;
    }
    return current;
  }

  /**
   * Hands the release-time purge failure to the quarantine coordinator instead
   * of readiness-checking the device back into circulation: the first warm-pool
   * version did that (see docs/internal/KNOWN-PITFALLS.md) so a dirty device could still
   * be leased, which is exactly the confusing failure mode quarantine replaces.
   */
  async #recoverPurgeFailure(
    deviceId: string,
    leaseId: string,
    startedAt: number,
    attemptedStrategy: QuarantinePurgeFailure["attemptedStrategy"],
    error: unknown,
  ): Promise<void> {
    await this.options.quarantine.enter({
      attemptedStrategy,
      deviceId,
      duration: this.options.clock.now() - startedAt,
      error: stableError(error),
      leaseId,
    });
  }
}

/**
 * `address` is never trusted by a driver's `shutdown` / `reclaim` / `makeReady` -- they derive
 * whatever they need from `driverData` -- so a placeholder here is harmless.
 */
function toDriverDevice(device: DeviceRecord): DriverDevice {
  return {
    address: device.address ?? "",
    deviceId: device.driverDeviceId,
    driverData: device.driverData,
  };
}

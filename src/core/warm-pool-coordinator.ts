import type { EventBus } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import type { CapacityDecision, CapacityDevice, RunningCapacity } from "./capacity/index.js";
import {
  type DeviceRecord,
  type DeviceSpec,
  type DeviceTransitionUpdate,
  type LeaseRecord,
  type Platform,
  sameSpec,
} from "./domain.js";
import type { Driver, DriverDevice } from "./driver.js";
import type { QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import type { ReleasedLease } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";

export interface WarmPoolDriverCatalog {
  get(platform: Platform): Driver;
}

export interface WarmPoolRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
  transitionDevice(
    deviceId: string,
    to: "ready" | "shutdown",
    event: {
      readonly event: "device.reclaimed";
      readonly payload: {
        readonly deviceId: string;
        readonly duration: number;
        readonly strategy: "erase" | "snapshot" | "wipe";
      };
    },
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord>;
  completeInterruptedReclaim(deviceId: string): Promise<DeviceRecord>;
}

export interface WarmPoolCapacityReader {
  runningCapacity(devices: readonly CapacityDevice[]): RunningCapacity;
  canReserveRunning(platform: Platform, devices: readonly CapacityDevice[]): CapacityDecision;
}

/** Where a release-time purge failure is handed off once the reclaim attempt commits. */
export interface WarmPoolQuarantine {
  enter(failure: QuarantinePurgeFailure): Promise<void>;
}

export interface WarmPoolCoordinatorOptions {
  readonly capacity: WarmPoolCapacityReader;
  readonly clock: Clock;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: WarmPoolDriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly notifyAvailability: () => void;
  readonly quarantine: WarmPoolQuarantine;
  readonly queueHeadDemand: () => { readonly spec?: DeviceSpec } | undefined;
  readonly registry: WarmPoolRegistry;
}

/**
 * Reclaims released devices and commits their warm-pool disposition. Driver
 * work remains outside the serialized registry decision sections.
 */
export class WarmPoolCoordinator {
  constructor(private readonly options: WarmPoolCoordinatorOptions) {}

  async reclaim(released: ReleasedLease): Promise<void> {
    const driver = this.options.drivers.get(released.device.spec.platform);
    const startedAt = this.options.clock.now();
    const attemptedStrategy = driver.reclaimStrategy({ clean: "standard" });
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(released.device), { clean: "standard" });
    } catch (error: unknown) {
      await this.#recoverPurgeFailure(released, startedAt, attemptedStrategy, error);
      return;
    }

    const keepReady = await this.options.decisions.run(async () =>
      this.#mayRemainWarm(released.device),
    );
    const disposition = await this.#disposition(driver, released.device, result.state, keepReady);
    await this.options.decisions.run(async () => {
      await this.options.registry.transitionDevice(
        released.device.id,
        disposition.state,
        {
          event: "device.reclaimed",
          payload: {
            deviceId: released.device.id,
            duration: this.options.clock.now() - startedAt,
            strategy: result.strategy,
          },
        },
        disposition.readyDevice === undefined
          ? undefined
          : {
              address: disposition.readyDevice.address,
              driverData: disposition.readyDevice.driverData,
            },
      );
    });
    this.options.notifyAvailability();
  }

  /** Safely finishes an unleased reclaim interrupted before its disposition commit. */
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

    await this.options.drivers.get(device.spec.platform).shutdown(toDriverDevice(device));
    const recovered = await this.options.decisions.run(async () => {
      const current = this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === deviceId,
      );
      const leased = this.options.registry.snapshot.leases.some(
        (lease) => lease.deviceId === deviceId,
      );
      if (current?.state !== "reclaiming" || leased) return false;
      await this.options.registry.completeInterruptedReclaim(deviceId);
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
   * Hands the release-time purge failure to the quarantine coordinator instead
   * of readiness-checking the device back into circulation: the first warm-pool
   * version did that (see docs/known-pitfalls.md) so a dirty device could still
   * be leased, which is exactly the confusing failure mode quarantine replaces.
   */
  async #recoverPurgeFailure(
    released: ReleasedLease,
    startedAt: number,
    attemptedStrategy: "erase" | "snapshot" | "wipe",
    error: unknown,
  ): Promise<void> {
    await this.options.quarantine.enter({
      attemptedStrategy,
      deviceId: released.device.id,
      duration: this.options.clock.now() - startedAt,
      error: stableError(error),
      leaseId: released.lease.id,
    });
  }

  async #disposition(
    driver: Driver,
    device: DeviceRecord,
    reclaimedState: "ready" | "shutdown",
    keepReady: boolean,
  ): Promise<{ readonly state: "ready" | "shutdown"; readonly readyDevice?: DriverDevice }> {
    if (keepReady && reclaimedState === "shutdown") {
      const readyDevice = await this.#tryMakeReady(driver, device);
      return readyDevice === undefined ? { state: "shutdown" } : { readyDevice, state: "ready" };
    }
    if (!keepReady && reclaimedState === "ready") {
      try {
        await driver.shutdown(toDriverDevice(device));
        return { state: "shutdown" };
      } catch {
        return { state: "ready" };
      }
    }
    return { state: reclaimedState };
  }

  /** Undefined on failure; otherwise the driver's freshly re-read device, address included. */
  async #tryMakeReady(driver: Driver, device: DeviceRecord): Promise<DriverDevice | undefined> {
    try {
      return await driver.makeReady(toDriverDevice(device));
    } catch {
      return undefined;
    }
  }

  #mayRemainWarm(device: DeviceRecord): boolean {
    const devices = capacityDevices(this.options.registry.snapshot.devices);
    const capacity = this.options.capacity.runningCapacity(devices);
    if (
      capacity.global.running > capacity.global.maxRunning ||
      capacity[device.spec.platform].running > capacity[device.spec.platform].maxRunning
    ) {
      return false;
    }
    const head = this.options.queueHeadDemand();
    if (head?.spec === undefined || sameSpec(head.spec, device.spec)) return true;
    return this.options.capacity.canReserveRunning(head.spec.platform, devices).ok;
  }
}

function capacityDevices(devices: readonly DeviceRecord[]): readonly CapacityDevice[] {
  return devices.map((device) => ({ platform: device.spec.platform, state: device.state }));
}

function stableError(error: unknown): string {
  const value = error instanceof Error ? error : new Error(String(error));
  return `${value.name}: ${value.message}`;
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

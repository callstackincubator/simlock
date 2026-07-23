import type { EventBus } from "../bus/index.js";
import type { Clock } from "../ports/index.js";
import type { CapacityDecision, CapacityDevice, RunningCapacity } from "./capacity.js";
import type { DeviceRecord, DeviceSpec, LeaseRecord, Platform } from "./domain.js";
import type { Driver, DriverDevice } from "./driver.js";
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
  ): Promise<DeviceRecord>;
  completeFailedPurge(deviceId: string, to: "ready" | "shutdown"): Promise<DeviceRecord>;
}

export interface WarmPoolCapacityReader {
  runningCapacity(devices: readonly CapacityDevice[]): RunningCapacity;
  canReserveRunning(platform: Platform, devices: readonly CapacityDevice[]): CapacityDecision;
}

export interface WarmPoolCoordinatorOptions {
  readonly capacity: WarmPoolCapacityReader;
  readonly clock: Clock;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: WarmPoolDriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly notifyAvailability: () => void;
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
    const finalState = await this.#disposition(driver, released.device, result.state, keepReady);
    await this.options.decisions.run(async () => {
      await this.options.registry.transitionDevice(released.device.id, finalState, {
        event: "device.reclaimed",
        payload: {
          deviceId: released.device.id,
          duration: this.options.clock.now() - startedAt,
          strategy: result.strategy,
        },
      });
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
      await this.options.registry.completeFailedPurge(deviceId, "shutdown");
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

  async #recoverPurgeFailure(
    released: ReleasedLease,
    startedAt: number,
    attemptedStrategy: "erase" | "snapshot" | "wipe",
    error: unknown,
  ): Promise<void> {
    const driver = this.options.drivers.get(released.device.spec.platform);
    const ready = await this.#tryMakeReady(driver, released.device);
    const duration = this.options.clock.now() - startedAt;
    await this.options.decisions.run(async () => {
      await this.options.registry.completeFailedPurge(
        released.device.id,
        ready ? "ready" : "shutdown",
      );
      this.options.eventBus.emit(
        "device.purge-failed",
        {
          attemptedStrategy,
          deviceId: released.device.id,
          duration,
          error: stableError(error),
          leaseId: released.lease.id,
        },
        "warm-pool-coordinator",
      );
    });
    this.options.notifyAvailability();
  }

  async #disposition(
    driver: Driver,
    device: DeviceRecord,
    reclaimedState: "ready" | "shutdown",
    keepReady: boolean,
  ): Promise<"ready" | "shutdown"> {
    if (keepReady && reclaimedState === "shutdown") {
      return (await this.#tryMakeReady(driver, device)) ? "ready" : "shutdown";
    }
    if (!keepReady && reclaimedState === "ready") {
      try {
        await driver.shutdown(toDriverDevice(device));
        return "shutdown";
      } catch {
        return "ready";
      }
    }
    return reclaimedState;
  }

  async #tryMakeReady(driver: Driver, device: DeviceRecord): Promise<boolean> {
    try {
      await driver.makeReady(toDriverDevice(device));
      return true;
    } catch {
      return false;
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

function sameSpec(left: DeviceSpec, right: DeviceSpec): boolean {
  return (
    left.platform === right.platform &&
    left.model === right.model &&
    left.osVersion === right.osVersion
  );
}

function stableError(error: unknown): string {
  const value = error instanceof Error ? error : new Error(String(error));
  return `${value.name}: ${value.message}`;
}

function toDriverDevice(device: DeviceRecord): DriverDevice {
  return { deviceId: device.driverDeviceId, driverData: device.driverData };
}

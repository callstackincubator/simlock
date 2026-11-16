import { vi, type Mock } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock, type Logger } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { VirtualDevice, VirtualSpec } from "./domain.js";
import { FakeDriver } from "./testing.js";
import {
  QuarantineCoordinator,
  type QuarantineRegistry,
  type QuarantineRetryConfig,
} from "./quarantine-coordinator.js";
import { SerializedDecision } from "./serialized-decision.js";

export const spec: VirtualSpec = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
};

export const retryConfig: QuarantineRetryConfig = {
  maxRetries: 2,
  retryBackoffMs: 1_000,
  retryBackoffMultiplier: 2,
  maxRetryBackoffMs: 5_000,
};

export class FakeRegistry implements QuarantineRegistry {
  #devices: VirtualDevice[];
  readonly deletions: string[] = [];
  constructor(devices: readonly VirtualDevice[]) {
    this.#devices = [...devices];
  }
  get snapshot(): {
    readonly devices: readonly VirtualDevice[];
    readonly virtualDevices: readonly VirtualDevice[];
  } {
    const copies = this.#devices.map((device) => ({ ...device }));
    return { devices: copies, virtualDevices: copies };
  }
  async enterQuarantine(deviceId: string, nextRetryAt: number): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => ({
      ...device,
      quarantineAttempts: 0,
      quarantineNextRetryAt: nextRetryAt,
      state: "quarantined",
    }));
  }
  async recordQuarantineRetryFailure(
    deviceId: string,
    attempts: number,
    nextRetryAt: number,
  ): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => ({
      ...device,
      quarantineAttempts: attempts,
      quarantineNextRetryAt: nextRetryAt,
    }));
  }
  async strandQuarantine(deviceId: string, attempts: number): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => {
      const { quarantineNextRetryAt: _quarantineNextRetryAt, ...rest } = device;
      return { ...rest, quarantineAttempts: attempts };
    });
  }
  async recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => {
      const {
        quarantineAttempts: _quarantineAttempts,
        quarantineNextRetryAt: _quarantineNextRetryAt,
        quarantinedAt: _quarantinedAt,
        ...rest
      } = device;
      return { ...rest, state: to };
    });
  }
  async deleteQuarantined(deviceId: string, initiator: string): Promise<VirtualDevice> {
    this.deletions.push(initiator);
    return this.#update(deviceId, (device) => {
      const {
        quarantineAttempts: _quarantineAttempts,
        quarantineNextRetryAt: _quarantineNextRetryAt,
        quarantinedAt: _quarantinedAt,
        ...rest
      } = device;
      return { ...rest, state: "deleted" };
    });
  }
  /** Test-only escape hatch to simulate a device leaving quarantine out of band. */
  // fallow-ignore-next-line unused-class-member -- the quarantine tests call it on the harness this file builds.
  forceState(deviceId: string, state: VirtualDevice["state"]): void {
    this.#update(deviceId, (device) => ({ ...device, state }));
  }
  #update(deviceId: string, apply: (device: VirtualDevice) => VirtualDevice): VirtualDevice {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error(`missing device: ${deviceId}`);
    const updated = apply(current);
    this.#devices[index] = updated;
    return { ...updated };
  }
}

export function device(id: string, driverDeviceId: string): VirtualDevice {
  return {
    physical: false,
    createdAt: 1,
    driverData: {},
    driverDeviceId,
    id,
    mode: "full",
    spec,
    state: "quarantined",
  };
}

export async function createHarness(
  options: {
    readonly clock?: FakeClock;
    readonly config?: QuarantineRetryConfig;
    readonly driver?: FakeDriver;
    readonly logger?: Logger;
    readonly others?: readonly VirtualDevice[];
    readonly physicalDeviceReady?: (deviceId: string) => void;
    readonly target?: Pick<VirtualDevice, "lastLeaseEndedAt" | "leaseIdentity"> & {
      readonly state?: VirtualDevice["state"];
    };
  } = {},
) {
  const clock = options.clock ?? new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver = options.driver ?? new FakeDriver({ clock, platform: "ios" });
  const driverDevice = await driver.provision(spec);
  const target = { ...device("dev_1", driverDevice.deviceId), ...options.target };
  const registry = new FakeRegistry([...(options.others ?? []), target]);
  const notifyAvailability: Mock<() => void> = vi.fn();
  const claims = new DeviceOperationClaims();
  const coordinator = new QuarantineCoordinator({
    claims,
    clock,
    config: options.config ?? retryConfig,
    decisions: new SerializedDecision(),
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    notifyAvailability,
    ...(options.physicalDeviceReady === undefined
      ? {}
      : { physicalDeviceReady: options.physicalDeviceReady }),
    registry,
  });
  return { bus, claims, clock, coordinator, driver, notifyAvailability, registry, target };
}

/** Lets the microtask queue (the fire-and-forget retry chain) settle after a timer fires. */
export async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}

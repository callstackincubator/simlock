import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import type { Config } from "./config.js";
import type { DriverRejection } from "./driver.js";
import type { Registry } from "./registry.js";
import { loadTestRegistry } from "./testing.js";
import type { TestEngineConfig } from "../leasing/testing.js";

export function loadRegistry(clock: FakeClock, eventBus: EventBus): Promise<Registry> {
  return loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
  });
}

export async function readyIosDevice() {
  const clock = new FakeClock(10_000);
  const eventBus = new EventBus(clock);
  const registry = await loadTestRegistry({
    clock,
    eventBus,
    idGenerator: sequence(),
  });
  const registered = await registry.registerDevice({
    backend: "local",
    driverData: { fakeDeviceId: "device-1" },
    driverDeviceId: "device-1",
    provisionDuration: 0,
    spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
  });
  await registry.transitionDevice(registered.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: registered.id },
  });
  return { eventBus, registry };
}

export function rootRejection(): DriverRejection {
  return {
    event: "driver.root-rejected",
    payload: { platform: "ios", reason: "missing-marker", root: "/Devices" },
    platform: "ios",
    reason: "missing-marker",
    summary: "Refusing the ios device root /Devices: it carries no marker",
  };
}

export async function readyDevice(
  registry: Registry,
  driverDeviceId: string,
  platform: "ios" | "android",
) {
  const device = await registry.registerDevice({
    backend: "local",
    driverData: { fakeDeviceId: driverDeviceId },
    driverDeviceId,
    provisionDuration: 0,
    spec: { physical: false, model: "Phone", osVersion: "1", platform },
  });
  await registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  return registry.snapshot.devices.find((candidate) => candidate.id === device.id)!;
}

export function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

export function config(
  stalledTransitionOverrides: Partial<Config["stalledTransition"]> = {},
): TestEngineConfig {
  return {
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    idle: { deleteAfterMs: 10, shutdownAfterMs: 5 },
    lease: {
      defaultTtlMs: 60_000,
      maxTtlMs: 3_600_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      maxPerRequester: 1,
      endWaitMs: 600_000,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 1 + 1,
        },
        ramBudget: { androidBytesPerDevice: 1, iosBytesPerDevice: 1 },
      },
    },
    warmPool: {
      enabled: true,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
    stalledTransition: {
      thresholdMultiplier: 3,
      minimumThresholdMs: 1_000,
      ...stalledTransitionOverrides,
    },
  };
}

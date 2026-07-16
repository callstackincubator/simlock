import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import {
  type CleanupRule,
  type Config,
  automaticCleanupRules,
  CleanupReaper,
  FakeDriver,
  LeaseEngine,
  Registry,
} from "./index.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.pitlane/state.json";
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function config(): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 100, heldTtlBackstopMs: 100 },
    limits: { android: { maxDevices: 1 }, ios: { maxDevices: 1 } },
    ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    warmPool: {},
  };
}

async function createHarness(
  rules: readonly CleanupRule[],
  latencyMs: Partial<Record<"destroy" | "shutdown", number>> = {},
  options: { readonly cleanupConfig?: Config; readonly tickMs?: number } = {},
) {
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    latencyMs,
    platform: "ios",
  });
  let nextId = 1;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const cleanupConfig = options.cleanupConfig ?? config();
  const engine = new LeaseEngine({
    clock,
    config: cleanupConfig,
    drivers: [driver],
    eventBus,
    idGenerator: { generate: () => `request-${nextId++}` },
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const reaper = new CleanupReaper({
    clock,
    config: cleanupConfig,
    eventBus,
    filesystem,
    leaseEngine: engine,
    registry,
    rules,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
  });

  return { clock, driver, engine, eventBus, reaper, registry };
}

async function seedReady(harness: Awaited<ReturnType<typeof createHarness>>) {
  const driverDevice = await harness.driver.provision(spec);
  const device = await harness.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  await harness.registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  return device;
}

async function seedLeased(harness: Awaited<ReturnType<typeof createHarness>>) {
  const device = await seedReady(harness);
  await harness.registry.createLease({
    deviceId: device.id,
    mode: "held",
    requesterId: "agent-1",
    ttlDeadline: 2_000,
  });
  return device;
}

async function seedShutdown(harness: Awaited<ReturnType<typeof createHarness>>) {
  const device = await seedReady(harness);
  await harness.driver.shutdown({ deviceId: device.driverDeviceId, driverData: device.driverData });
  await harness.registry.transitionDevice(device.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: device.id, initiator: "test" },
  });
  return device;
}

async function flush(): Promise<void> {
  for (let count = 0; count < 20; count += 1) {
    await Promise.resolve();
  }
}

describe("CleanupReaper", () => {
  it("centrally rejects a malicious rule targeting a leased or unknown device", async () => {
    const maliciousRule: CleanupRule = {
      evaluate: () => [
        { action: "destroy", reason: "ignore safety", rule: "malicious", target: "dev_1" },
        { action: "destroy", reason: "ignore safety", rule: "malicious", target: "dev_unknown" },
      ],
      name: "malicious",
    };
    const harness = await createHarness([maliciousRule]);
    await seedLeased(harness);

    await expect(harness.reaper.run()).resolves.toEqual([]);
    expect(
      harness.driver.calls.filter(
        (call) => call.operation === "shutdown" || call.operation === "destroy",
      ),
    ).toEqual([]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");
  });

  it("executes a valid proposal through the driver and committed registry transition", async () => {
    const rule: CleanupRule = {
      evaluate: () => [
        { action: "shutdown", reason: "test cleanup", rule: "test-rule", target: "dev_1" },
      ],
      name: "test-rule",
    };
    const harness = await createHarness([rule]);
    await seedReady(harness);

    await expect(harness.reaper.run()).resolves.toEqual([
      { action: "shutdown", reason: "test cleanup", rule: "test-rule", target: "dev_1" },
    ]);
    expect(harness.driver.calls.map((call) => call.operation)).toEqual(["provision", "shutdown"]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
    expect(harness.eventBus.replay().at(-1)).toMatchObject({
      event: "cleanup.executed",
      payload: {
        action: "shutdown",
        reason: "test cleanup",
        ruleName: "test-rule",
        target: "dev_1",
      },
    });
  });

  it("dedupes shutdown and destroy in favor of destroy, and dry-run is side-effect-free", async () => {
    const rule: CleanupRule = {
      evaluate: () => [
        { action: "shutdown", reason: "first proposal", rule: "test-rule", target: "dev_1" },
        { action: "destroy", reason: "more complete", rule: "test-rule", target: "dev_1" },
      ],
      name: "test-rule",
    };
    const harness = await createHarness([rule]);
    await seedShutdown(harness);
    const before = harness.registry.snapshot;
    const callsBefore = harness.driver.calls.length;

    await expect(harness.reaper.run({ dryRun: true })).resolves.toEqual([
      { action: "destroy", reason: "more complete", rule: "test-rule", target: "dev_1" },
    ]);
    expect(harness.driver.calls).toHaveLength(callsBefore);
    expect(harness.registry.snapshot).toEqual(before);
  });

  it("keeps cleanup out of a configured warm pool until warm-pool policy exists", async () => {
    const rule: CleanupRule = {
      evaluate: () => [
        { action: "shutdown", reason: "test cleanup", rule: "test-rule", target: "dev_1" },
      ],
      name: "test-rule",
    };
    const cleanupConfig = { ...config(), warmPool: { reserved: 1 } };
    const harness = await createHarness([rule], {}, { cleanupConfig });
    await seedReady(harness);

    await expect(harness.reaper.run()).resolves.toEqual([]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    harness.reaper.dispose();
  });

  it("registers runtime GC only for explicit manual cleanup", async () => {
    const harness = await createHarness([]);

    expect(harness.reaper.manualRules.map((rule) => rule.name)).toEqual(["runtime-gc"]);
    await expect(harness.reaper.run({ dryRun: true, rule: "runtime-gc" })).resolves.toEqual([]);
    harness.reaper.dispose();
  });

  it("coalesces five trigger events during a run into one follow-up run", async () => {
    const evaluate = vi.fn(() => [
      { action: "shutdown" as const, reason: "test cleanup", rule: "test-rule", target: "dev_1" },
    ]);
    const harness = await createHarness([{ evaluate, name: "test-rule" }], { shutdown: 10 });
    await seedReady(harness);

    harness.eventBus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await flush();
    for (let count = 0; count < 5; count += 1) {
      harness.eventBus.emit("disk.pressure-detected", { freeBytes: 0, threshold: 1 }, "test");
    }
    harness.clock.advance(10);
    await flush();

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);
    harness.reaper.dispose();
  });

  it("shuts down after T1 and destroys after T2 on periodic ticks following a release", async () => {
    const harness = await createHarness(automaticCleanupRules, {}, { tickMs: 10_000 });
    const grant = await harness.engine.request(spec, { mode: "held", requesterId: "agent-1" });

    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    harness.clock.advance(10_000);
    await flush();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");

    harness.clock.advance(10_000);
    await flush();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");

    harness.clock.advance(10_000);
    await flush();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");

    harness.clock.advance(10_000);
    await flush();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
    expect(harness.driver.calls.map((call) => call.operation)).toContain("destroy");
    harness.reaper.dispose();
  });

  it("prevents the lease engine from granting a device while cleanup is shutting it down", async () => {
    const rule: CleanupRule = {
      evaluate: () => [
        { action: "shutdown", reason: "test cleanup", rule: "test-rule", target: "dev_1" },
      ],
      name: "test-rule",
    };
    const harness = await createHarness([rule], { shutdown: 10 });
    await seedReady(harness);

    const cleanup = harness.reaper.run();
    await flush();
    const request = harness.engine.request(spec, { mode: "held", requesterId: "agent-2" });
    await flush();
    expect(harness.registry.snapshot.leases).toEqual([]);

    harness.clock.advance(10);
    await cleanup;
    await flush();
    expect(harness.registry.snapshot.leases).toMatchObject([{ requesterId: "agent-2" }]);
    await expect(request).resolves.toMatchObject({ lease: { requesterId: "agent-2" } });
    harness.reaper.dispose();
  });
});

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
import { CleanupExecutor } from "./cleanup-executor.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { SerializedDecision } from "./serialized-decision.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

/**
 * MemoryFilesystem's free-disk figure is fixed at construction; this
 * subclass lets one test flip it between ticks to exercise the crossing edge.
 */
class MutableFreeDiskFilesystem extends MemoryFilesystem {
  #freeDiskBytes: number;

  constructor(freeDiskBytes = Number.MAX_SAFE_INTEGER) {
    super(freeDiskBytes);
    this.#freeDiskBytes = freeDiskBytes;
  }

  override async diskFree(): Promise<number> {
    return this.#freeDiskBytes;
  }

  setFreeDiskBytes(bytes: number): void {
    this.#freeDiskBytes = bytes;
  }
}

function config(): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    drivers: {},
    eventBuffer: { capacity: 100 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 30_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 100, heldTtlBackstopMs: 100, heartbeatIntervalMs: 25 },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 1 + 1,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

async function createHarness(
  rules: readonly CleanupRule[],
  latencyMs: Partial<Record<"destroy" | "shutdown", number>> = {},
  options: {
    readonly cleanupConfig?: Config;
    readonly filesystem?: MemoryFilesystem;
    readonly tickMs?: number;
    readonly useLeaseEngineExecutor?: boolean;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const filesystem = options.filesystem ?? new MemoryFilesystem();
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
  const executor = options.useLeaseEngineExecutor
    ? {
        execute: (proposal: Parameters<LeaseEngine["executeCleanup"]>[0]) =>
          engine.executeCleanup(proposal),
      }
    : (() => {
        const claims = new DeviceOperationClaims();
        const decisions = new SerializedDecision();
        const catalog = new DriverCatalog([driver]);
        return new CleanupExecutor({
          eventBus,
          lifecycle: new ManagedDeviceLifecycle(catalog, registry, decisions, claims, clock),
          notifyAvailability: () => {},
          registry,
        });
      })();
  const reaper = new CleanupReaper({
    clock,
    config: cleanupConfig,
    eventBus,
    filesystem,
    executor,
    registry,
    rules,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
  });

  return { clock, driver, engine, eventBus, filesystem, reaper, registry };
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
  await harness.driver.shutdown({
    address: device.address ?? "",
    deviceId: device.driverDeviceId,
    driverData: device.driverData,
  });
  await harness.registry.transitionDevice(device.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: device.id, initiator: "test" },
  });
  return device;
}

async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
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

  it("selects --rule by name across the rules that actually exist", async () => {
    const harness = await createHarness(automaticCleanupRules);

    expect(harness.reaper.rules.map((rule) => rule.name)).toEqual([
      "idle-shutdown",
      "idle-destroy",
    ]);
    await expect(harness.reaper.run({ dryRun: true, rule: "idle-shutdown" })).resolves.toEqual([]);
    await expect(harness.reaper.run({ dryRun: true, rule: "unknown-rule" })).resolves.toEqual([]);
    harness.reaper.dispose();
  });

  it("emits disk.pressure-detected once per crossing, not once per sustained tick, and again after recovering and re-crossing", async () => {
    const filesystem = new MutableFreeDiskFilesystem();
    const harness = await createHarness([], {}, { filesystem, tickMs: 10_000 });
    const pressureEvents = () =>
      harness.eventBus.replay().filter((event) => event.event === "disk.pressure-detected");

    // Starts well above threshold: no emission on the first couple of ticks.
    harness.clock.advance(10_000);
    await flush();
    harness.clock.advance(10_000);
    await flush();
    expect(pressureEvents()).toHaveLength(0);

    // Crosses under threshold and stays there for several ticks: emits once.
    filesystem.setFreeDiskBytes(2 * gibibyte);
    harness.clock.advance(10_000);
    await flush();
    harness.clock.advance(10_000);
    await flush();
    harness.clock.advance(10_000);
    await flush();
    expect(pressureEvents()).toHaveLength(1);
    expect(pressureEvents()[0]).toMatchObject({
      payload: { freeBytes: 2 * gibibyte, threshold: 10 * gibibyte },
    });

    // Recovers above threshold: no new emission.
    filesystem.setFreeDiskBytes(20 * gibibyte);
    harness.clock.advance(10_000);
    await flush();
    expect(pressureEvents()).toHaveLength(1);

    // Crosses under threshold again: emits a second time.
    filesystem.setFreeDiskBytes(1 * gibibyte);
    harness.clock.advance(10_000);
    await flush();
    expect(pressureEvents()).toHaveLength(2);

    harness.reaper.dispose();
  });

  it("stays side-effect free on a dry run under pressure, emitting nothing and running once", async () => {
    const filesystem = new MutableFreeDiskFilesystem();
    filesystem.setFreeDiskBytes(2 * gibibyte);
    const evaluate = vi.fn(() => []);
    const harness = await createHarness([{ evaluate, name: "test-rule" }], {}, { filesystem });

    await harness.reaper.run({ dryRun: true });
    await flush();

    // Emitting the fact from a preview would wake this reaper through its own
    // disk.pressure-detected subscription, so `cleanup --dry-run` would quietly
    // schedule a real cleanup run -- visible here as a second rule evaluation.
    expect(
      harness.eventBus.replay().filter((event) => event.event === "disk.pressure-detected"),
    ).toHaveLength(0);
    expect(evaluate).toHaveBeenCalledTimes(1);

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
    const harness = await createHarness([rule], { shutdown: 10 }, { useLeaseEngineExecutor: true });
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

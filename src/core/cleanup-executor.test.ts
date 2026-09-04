import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { CleanupExecutor } from "./cleanup-executor.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

const statePath = "/home/agent/.simlock/state.json";
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

async function createHarness() {
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: { generate: () => "1" },
    statePath,
  });
  const claims = new DeviceOperationClaims();
  const decisions = new SerializedDecision();
  const catalog = new DriverCatalog([driver]);
  const notifyAvailability = vi.fn();
  const executor = new CleanupExecutor({
    eventBus,
    lifecycle: new ManagedDeviceLifecycle(catalog, registry, decisions, claims, clock),
    notifyAvailability,
    registry,
  });
  return { claims, driver, eventBus, executor, notifyAvailability, registry };
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

describe("CleanupExecutor", () => {
  it("rejects unknown and leased targets without calling a driver", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    await harness.registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "agent-1",
      ownerId: "agent-1",
      ttlDeadline: 2_000,
    });

    await expect(
      harness.executor.execute({
        action: "destroy",
        reason: "malicious",
        rule: "bad",
        target: "missing",
      }),
    ).resolves.toBe(false);
    await expect(
      harness.executor.execute({
        action: "shutdown",
        reason: "malicious",
        rule: "bad",
        target: device.id,
      }),
    ).resolves.toBe(false);
    expect(harness.driver.calls.map((call) => call.operation)).toEqual(["provision"]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");
  });

  it("rejects an operation that another coordinator has claimed", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    const claim = harness.claims.tryClaim(device.id, "boot");
    expect(claim).toBeDefined();

    await expect(
      harness.executor.execute({
        action: "shutdown",
        reason: "idle",
        rule: "idle",
        target: device.id,
      }),
    ).resolves.toBe(false);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.driver.calls.map((call) => call.operation)).toEqual(["provision"]);
  });

  it("releases its claim when the driver fails", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    harness.driver.failOn("shutdown", 1, new Error("driver failed"));

    await expect(
      harness.executor.execute({
        action: "shutdown",
        reason: "idle",
        rule: "idle",
        target: device.id,
      }),
    ).rejects.toThrow("driver failed");
    expect(harness.claims.isClaimed(device.id)).toBe(false);
    expect(harness.claims.tryClaim(device.id, "cleanup")).toBeDefined();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("commits valid shutdown and destroy actions, emits attribution, and wakes demand", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    const shutdown = {
      action: "shutdown" as const,
      reason: "idle 11m",
      rule: "idle",
      target: device.id,
    };

    await expect(harness.executor.execute(shutdown)).resolves.toBe(true);
    await expect(
      harness.executor.execute({
        action: "destroy",
        reason: "idle 31m",
        rule: "idle",
        target: device.id,
      }),
    ).resolves.toBe(true);

    expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
    expect(harness.driver.calls.map((call) => call.operation)).toEqual([
      "provision",
      "shutdown",
      "destroy",
    ]);
    expect(harness.notifyAvailability).toHaveBeenCalledTimes(2);
    expect(harness.eventBus.replay().slice(-2)).toMatchObject([
      {
        event: "device.deleted",
        payload: { deviceId: device.id, initiator: "cleanup-reaper" },
      },
      {
        event: "cleanup.executed",
        module: "cleanup-executor",
        payload: { action: "destroy", reason: "idle 31m", ruleName: "idle", target: device.id },
      },
    ]);
  });
});

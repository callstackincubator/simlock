import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { type CapacityReservation } from "./capacity-coordinator.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import { DriverCatalog } from "./driver-catalog.js";
import { DriverCrashError, BootTimeoutError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

const statePath = "/home/agent/.pitlane/state.json";
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function reservation(): CapacityReservation & { readonly releaseCount: () => number } {
  let releases = 0;
  return { release: () => void releases++, releaseCount: () => releases };
}

async function createHarness(latencyMs?: {
  readonly makeReady?: number;
  readonly provision?: number;
}) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({
    clock,
    estimateMs: { boot: 20, provision: 30 },
    platform: "ios",
    ...(latencyMs === undefined ? {} : { latencyMs }),
  });
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: new MemoryFilesystem(),
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const decisions = new SerializedDecision();
  const lifecycle = new ManagedDeviceLifecycle(
    new DriverCatalog([driver]),
    registry,
    decisions,
    new DeviceOperationClaims(),
    clock,
  );
  const provisioner = new DeviceProvisioner({
    catalog: new DriverCatalog([driver]),
    clock,
    decisions,
    lifecycle,
    registry,
  });
  return { clock, driver, eventBus, provisioner, registry };
}

describe("DeviceProvisioner", () => {
  it("records provision and boot durations from the injected clock", async () => {
    const harness = await createHarness({ makeReady: 7, provision: 11 });
    const pending = harness.provisioner.provision(spec, { reservation: reservation() });

    harness.clock.advance(11);
    await vi.waitFor(() =>
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1),
    );
    harness.clock.advance(7);
    await pending;

    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.provisioned",
        payload: expect.objectContaining({ duration: 11 }),
      }),
    );
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.ready",
        payload: expect.objectContaining({ bootDuration: 7 }),
      }),
    );
  });

  it("provisions, registers, and readies a device with progress estimates and post-commit facts", async () => {
    const harness = await createHarness();
    const progress: string[] = [];
    const reserved = reservation();
    let readyStateAtEvent = "unknown";
    harness.eventBus.subscribe("device.ready", () => {
      readyStateAtEvent = harness.registry.snapshot.devices[0]?.state ?? "missing";
    });

    const ready = await harness.provisioner.provision(spec, {
      onProgress: (update) => progress.push(`${update.stage}:${update.etaMs}`),
      reservation: reserved,
    });

    expect(ready).toMatchObject({ state: "ready" });
    expect(progress).toEqual(["provisioning:30", "booting:20"]);
    expect(readyStateAtEvent).toBe("ready");
    expect(reserved.releaseCount()).toBe(1);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.provisioned",
        payload: expect.objectContaining({ duration: 0 }),
      }),
    );
  });

  it("rolls back a registered device and returns BootTimeoutError-compatible failure on boot failure", async () => {
    const harness = await createHarness();
    const reserved = reservation();
    harness.driver.failOn("makeReady", 1, new DriverCrashError("boot failed"));

    await expect(
      harness.provisioner.provision(spec, { reservation: reserved }),
    ).rejects.toBeInstanceOf(BootTimeoutError);
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({ event: "device.deleted" }),
    );
    expect(reserved.releaseCount()).toBe(1);
  });

  it("releases its capacity reservation when the driver cannot provision", async () => {
    const harness = await createHarness();
    const reserved = reservation();
    harness.driver.failOn("provision", 1, new DriverCrashError("driver unavailable"));

    await expect(harness.provisioner.provision(spec, { reservation: reserved })).rejects.toThrow(
      "driver unavailable",
    );
    expect(harness.registry.snapshot.devices).toEqual([]);
    expect(reserved.releaseCount()).toBe(1);
  });
});

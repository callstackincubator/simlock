import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import { DriverCrashError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

const statePath = "/home/agent/.pitlane/state.json";

async function createHarness() {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({ clock, platform: "ios" });
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: new MemoryFilesystem(),
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const claims = new DeviceOperationClaims();
  const lifecycle = new ManagedDeviceLifecycle(
    new DriverCatalog([driver]),
    registry,
    new SerializedDecision(),
    claims,
    clock,
  );
  const driverDevice = await driver.provision({
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
  });
  const device = await registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
  });
  return { claims, clock, device, driver, eventBus, lifecycle, registry };
}

async function readyDevice(harness: Awaited<ReturnType<typeof createHarness>>) {
  await harness.driver.makeReady({
    deviceId: harness.device.driverDeviceId,
    driverData: harness.device.driverData,
  });
  return harness.registry.transitionDevice(harness.device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: harness.device.id },
  });
}

describe("ManagedDeviceLifecycle", () => {
  it("boots a registered shutdown device and emits device.ready after its commit", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    await harness.driver.shutdown({ deviceId: ready.driverDeviceId, driverData: ready.driverData });
    const shutdown = await harness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    let stateAtEvent = "unknown";
    harness.eventBus.subscribe("device.ready", () => {
      stateAtEvent = harness.registry.snapshot.devices[0]?.state ?? "missing";
    });

    const booted = await harness.lifecycle.boot(shutdown);

    expect(booted).toMatchObject({ id: shutdown.id, state: "ready" });
    expect(stateAtEvent).toBe("ready");
  });

  it("shuts down and destroys only registry-owned, unleased devices in expected states", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);

    expect(
      await harness.lifecycle.shutdown(
        { ...ready, driverDeviceId: "not-owned" },
        "test",
        "cleanup",
      ),
    ).toBeUndefined();
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(0);

    const shutdown = await harness.lifecycle.shutdown(ready, "test", "cleanup");
    expect(shutdown).toMatchObject({ state: "shutdown" });
    const deleted = await harness.lifecycle.destroy(shutdown!, "test", "cleanup");
    expect(deleted).toMatchObject({ state: "deleted" });
    expect(harness.eventBus.replay().map((event) => event.event)).toContain("device.deleted");
  });

  it("does not touch leased devices and releases claims after driver failures", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    await harness.registry.createLease({
      deviceId: ready.id,
      mode: "held",
      requesterId: "agent",
      ttlDeadline: 2_000,
    });
    expect(await harness.lifecycle.shutdown(ready, "test", "cleanup")).toBeUndefined();
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(0);

    const failureHarness = await createHarness();
    const failureReady = await readyDevice(failureHarness);
    failureHarness.driver.failOn("shutdown", 1, new DriverCrashError("failed to stop"));
    await expect(
      failureHarness.lifecycle.shutdown(failureReady, "test", "cleanup"),
    ).rejects.toThrow("failed to stop");
    expect(await failureHarness.lifecycle.shutdown(failureReady, "test", "cleanup")).toMatchObject({
      state: "shutdown",
    });
  });

  it("holds an exclusive claim while a boot driver call is in flight", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    await harness.driver.shutdown({ deviceId: ready.driverDeviceId, driverData: ready.driverData });
    const shutdown = await harness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    harness.driver.hangMakeReady();

    const booting = harness.lifecycle.boot(shutdown);
    await vi.waitFor(() =>
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2),
    );
    await expect(harness.lifecycle.boot(shutdown)).resolves.toBeUndefined();

    harness.driver.releaseMakeReady();
    await expect(booting).resolves.toMatchObject({ state: "ready" });
  });

  it("retains a boot claim after readiness for the immediate lease handoff", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    await harness.driver.shutdown({ deviceId: ready.driverDeviceId, driverData: ready.driverData });
    const shutdown = await harness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    const claim = harness.claims.tryClaim(shutdown.id, "boot");
    if (claim === undefined) throw new Error("expected boot claim");

    const handoff = await harness.lifecycle.bootForLease(shutdown, claim);
    expect(handoff).toMatchObject({ device: { state: "ready" } });
    await expect(
      harness.lifecycle.shutdown(handoff!.device, "test", "cleanup"),
    ).resolves.toBeUndefined();

    handoff!.claim.release();
    await expect(
      harness.lifecycle.shutdown(handoff!.device, "test", "cleanup"),
    ).resolves.toMatchObject({ state: "shutdown" });
  });

  describe("recoverLeased", () => {
    it("reboots a leased device under its own lease id without a registry transition", async () => {
      const harness = await createHarness();
      const ready = await readyDevice(harness);
      const lease = await harness.registry.createLease({
        deviceId: ready.id,
        mode: "held",
        requesterId: "agent",
        ttlDeadline: 10_000,
      });
      await harness.driver.shutdown({
        deviceId: ready.driverDeviceId,
        driverData: ready.driverData,
      });

      const recovered = await harness.lifecycle.recoverLeased(ready, lease.id);

      expect(recovered).toMatchObject({ id: ready.id, state: "leased" });
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2);
      expect(harness.registry.snapshot.leases).toContainEqual(lease);
      expect(harness.claims.isClaimed(ready.id)).toBe(false);
    });

    it("never touches a device leased under a different lease id", async () => {
      const harness = await createHarness();
      const ready = await readyDevice(harness);
      await harness.registry.createLease({
        deviceId: ready.id,
        mode: "held",
        requesterId: "agent",
        ttlDeadline: 10_000,
      });
      const makeReadyCallsBefore = harness.driver.calls.filter(
        (call) => call.operation === "makeReady",
      ).length;

      const recovered = await harness.lifecycle.recoverLeased(ready, "lse_someone-else");

      expect(recovered).toBeUndefined();
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
        makeReadyCallsBefore,
      );
      expect(harness.claims.isClaimed(ready.id)).toBe(false);
    });

    it("returns undefined for a device that is not leased at all", async () => {
      const harness = await createHarness();
      const ready = await readyDevice(harness);

      expect(await harness.lifecycle.recoverLeased(ready, "lse_anything")).toBeUndefined();
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);

      await harness.driver.shutdown({
        deviceId: ready.driverDeviceId,
        driverData: ready.driverData,
      });
      const shutdown = await harness.registry.transitionDevice(ready.id, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: ready.id, initiator: "test" },
      });
      expect(await harness.lifecycle.recoverLeased(shutdown, "lse_anything")).toBeUndefined();
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
    });

    it("returns undefined and releases the claim when the lease ends mid-boot", async () => {
      const harness = await createHarness();
      const ready = await readyDevice(harness);
      const lease = await harness.registry.createLease({
        deviceId: ready.id,
        mode: "held",
        requesterId: "agent",
        ttlDeadline: 10_000,
      });
      harness.driver.hangMakeReady();

      const recovering = harness.lifecycle.recoverLeased(ready, lease.id);
      await vi.waitFor(() =>
        expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
          2,
        ),
      );
      await harness.registry.beginRelease(lease.id);
      harness.driver.releaseMakeReady();

      expect(await recovering).toBeUndefined();
      expect(harness.claims.isClaimed(ready.id)).toBe(false);
    });

    it("does not act on a device already claimed for another operation", async () => {
      const harness = await createHarness();
      const ready = await readyDevice(harness);
      const lease = await harness.registry.createLease({
        deviceId: ready.id,
        mode: "held",
        requesterId: "agent",
        ttlDeadline: 10_000,
      });
      const claim = harness.claims.tryClaim(ready.id, "cleanup");
      if (claim === undefined) throw new Error("expected cleanup claim");
      const makeReadyCallsBefore = harness.driver.calls.filter(
        (call) => call.operation === "makeReady",
      ).length;

      const recovered = await harness.lifecycle.recoverLeased(ready, lease.id);

      expect(recovered).toBeUndefined();
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
        makeReadyCallsBefore,
      );
      expect(harness.claims.operationFor(ready.id)).toBe("cleanup");
      claim.release();
    });

    it("propagates a driver failure and releases the claim so recovery can be retried", async () => {
      const harness = await createHarness();
      const ready = await readyDevice(harness);
      const lease = await harness.registry.createLease({
        deviceId: ready.id,
        mode: "held",
        requesterId: "agent",
        ttlDeadline: 10_000,
      });
      harness.driver.failOn("makeReady", 2, new DriverCrashError("boot failed"));

      await expect(harness.lifecycle.recoverLeased(ready, lease.id)).rejects.toThrow("boot failed");
      expect(harness.claims.isClaimed(ready.id)).toBe(false);

      const retried = await harness.lifecycle.recoverLeased(ready, lease.id);
      expect(retried).toMatchObject({ id: ready.id, state: "leased" });
    });
  });
});

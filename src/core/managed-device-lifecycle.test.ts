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

const statePath = "/home/agent/.simlock/state.json";

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
    address: harness.device.address ?? "",
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
    await harness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
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

  it("replaces the stored address with the one makeReady re-read on the new boot", async () => {
    // The address a device is reachable at is a property of its current boot, not of the device:
    // an Android console port is assigned per boot, so a serial captured at provision goes stale
    // exactly in the warm-pool path (shutdown -> boot -> lease) that matters most. FakeDriver
    // returns a fresh address per boot for this reason; the registry must follow it.
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    const firstAddress = harness.registry.snapshot.devices[0]?.address;
    await harness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
    const shutdown = await harness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });

    const booted = await harness.lifecycle.boot(shutdown);

    expect(booted?.address).toBeDefined();
    expect(booted?.address).not.toBe(firstAddress);
    expect(harness.registry.snapshot.devices[0]?.address).toBe(booted?.address);
    // The ownership identity is not a per-boot fact and must not drift with the address.
    expect(booted?.driverDeviceId).toBe(ready.driverDeviceId);
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
    await harness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
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
    await harness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
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
        address: ready.address ?? "",
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
        address: ready.address ?? "",
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

    it("requests makeReady with purpose 'recover', never the default (finding #1, issue #87 review)", async () => {
      // Safety rule 2's crash-recovery exception may only reboot an already-provisioned,
      // still-leased device -- never apply any configuration change a normal "prepare" boot
      // might (the iOS driver's slim pass). `recoverLeased` must always ask for that narrower
      // contract explicitly; see `IosSimctlDriver.makeReady`'s dedicated coverage for what a
      // real driver does with it.
      const harness = await createHarness();
      const ready = await readyDevice(harness);
      const lease = await harness.registry.createLease({
        deviceId: ready.id,
        mode: "held",
        requesterId: "agent",
        ttlDeadline: 10_000,
      });

      await harness.lifecycle.recoverLeased(ready, lease.id);

      const recoveryCall = harness.driver.calls.filter((call) => call.operation === "makeReady")[
        harness.driver.calls.filter((call) => call.operation === "makeReady").length - 1
      ];
      expect(recoveryCall?.arguments[1]).toEqual({ purpose: "recover" });
    });
  });

  it("persists a driver's featureProfile alongside address and driverData on boot (#makeReady path)", async () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, featureProfile: "reduced", platform: "ios" });
    let nextId = 0;
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => `${nextId++}` },
      statePath,
    });
    const lifecycle = new ManagedDeviceLifecycle(
      new DriverCatalog([driver]),
      registry,
      new SerializedDecision(),
      new DeviceOperationClaims(),
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

    const ready = await lifecycle.readyProvisioned(device);

    expect(ready).toMatchObject({ featureProfile: "reduced" });
  });

  it("persists a driver's featureProfile via the bootForLease handoff path (#makeReadyForLease)", async () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, featureProfile: "reduced", platform: "ios" });
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

    const handoff = await lifecycle.readyProvisionedForLease(device);

    expect(handoff?.device).toMatchObject({ featureProfile: "reduced" });
  });

  it("boot clears a stale featureProfile when the driver now reports undefined (#makeReady, shutdown path)", async () => {
    // Regression for the HIGH finding: a conditional spread that omitted `featureProfile`
    // entirely whenever the driver returned `undefined` left a previously-stored "reduced" on
    // the record, so a device slim mode no longer applies to kept reporting `slim: true`.
    const harness = await createHarness();
    const ready = await harness.registry.transitionDevice(
      harness.device.id,
      "ready",
      { event: "device.ready", payload: { bootDuration: 0, deviceId: harness.device.id } },
      {
        address: harness.device.driverDeviceId,
        driverData: harness.device.driverData,
        featureProfile: "reduced",
      },
    );
    expect(ready.featureProfile).toBe("reduced");
    await harness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
    const shutdown = await harness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    expect(shutdown.featureProfile).toBe("reduced");

    // `harness.driver` (a plain `FakeDriver` with no `featureProfile` option) reports `undefined`
    // on this boot -- the driver-side equivalent of slim mode having been switched off.
    const booted = await harness.lifecycle.boot(shutdown);

    expect(booted?.featureProfile).toBeUndefined();
  });

  it("bootForLease clears a stale featureProfile when the driver now reports undefined (#makeReadyForLease, shutdown path)", async () => {
    const harness = await createHarness();
    const ready = await harness.registry.transitionDevice(
      harness.device.id,
      "ready",
      { event: "device.ready", payload: { bootDuration: 0, deviceId: harness.device.id } },
      {
        address: harness.device.driverDeviceId,
        driverData: harness.device.driverData,
        featureProfile: "reduced",
      },
    );
    await harness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
    const shutdown = await harness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    const claim = harness.claims.tryClaim(shutdown.id, "boot");
    if (claim === undefined) throw new Error("expected boot claim");

    const handoff = await harness.lifecycle.bootForLease(shutdown, claim);

    expect(handoff?.device.featureProfile).toBeUndefined();
  });

  it("readyProvisioned clears a stale featureProfile when the driver now reports undefined (#makeReady, provisioning path)", async () => {
    // A device can't naturally re-enter "provisioning" once it leaves, so the persisted state is
    // seeded directly (as a restarted daemon would load it from disk) to exercise the same
    // provisioning-branch code path the "shutdown" tests above cover for the other branch.
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, platform: "ios" });
    const driverDevice = await driver.provision({
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 0,
            driverData: driverDevice.driverData,
            driverDeviceId: driverDevice.deviceId,
            featureProfile: "reduced",
            id: "dev_stale",
            spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
            state: "provisioning",
          },
        ],
        leases: [],
      }),
    );
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem,
      idGenerator: { generate: () => "unused" },
      statePath,
    });
    const lifecycle = new ManagedDeviceLifecycle(
      new DriverCatalog([driver]),
      registry,
      new SerializedDecision(),
      new DeviceOperationClaims(),
      clock,
    );
    const device = registry.snapshot.devices[0];
    if (device === undefined) throw new Error("expected seeded device");
    expect(device.featureProfile).toBe("reduced");

    const readyDevice = await lifecycle.readyProvisioned(device);

    expect(readyDevice?.featureProfile).toBeUndefined();
  });

  it("readyProvisionedForLease clears a stale featureProfile when the driver now reports undefined (#makeReadyForLease, provisioning path)", async () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, platform: "ios" });
    const driverDevice = await driver.provision({
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      statePath,
      JSON.stringify({
        devices: [
          {
            createdAt: 0,
            driverData: driverDevice.driverData,
            driverDeviceId: driverDevice.deviceId,
            featureProfile: "reduced",
            id: "dev_stale_2",
            spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
            state: "provisioning",
          },
        ],
        leases: [],
      }),
    );
    const registry = await Registry.load({
      clock,
      eventBus,
      filesystem,
      idGenerator: { generate: () => "unused" },
      statePath,
    });
    const lifecycle = new ManagedDeviceLifecycle(
      new DriverCatalog([driver]),
      registry,
      new SerializedDecision(),
      new DeviceOperationClaims(),
      clock,
    );
    const device = registry.snapshot.devices[0];
    if (device === undefined) throw new Error("expected seeded device");

    const handoff = await lifecycle.readyProvisionedForLease(device);

    expect(handoff?.device.featureProfile).toBeUndefined();
  });
});

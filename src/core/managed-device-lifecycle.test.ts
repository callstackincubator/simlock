import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
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
  const booted = await harness.driver.makeReady(
    {
      address: harness.device.address ?? "",
      deviceId: harness.device.driverDeviceId,
      driverData: harness.device.driverData,
    },
    { mode: "full", purpose: "prepare" },
  );
  return harness.registry.transitionDevice(
    harness.device.id,
    "ready",
    {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: harness.device.id },
    },
    { address: booted.address },
  );
}

async function shutdownDevice(
  harness: Awaited<ReturnType<typeof createHarness>>,
  ready: Awaited<ReturnType<typeof readyDevice>>,
) {
  await harness.driver.shutdown({
    address: ready.address ?? "",
    deviceId: ready.driverDeviceId,
    driverData: ready.driverData,
  });
  return harness.registry.transitionDevice(ready.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: ready.id, initiator: "test" },
  });
}

describe("ManagedDeviceLifecycle", () => {
  it("replaces the stored address with the one makeReady re-read when booting a device for a lease", async () => {
    // The address a device is reachable at is a property of its current boot, not of the device:
    // an Android console port is assigned per boot, so a serial captured at provision goes stale
    // exactly in the warm-pool path (shutdown -> boot -> lease) that matters most. FakeDriver
    // returns a fresh address per boot for this reason; the registry must follow it. Driven
    // through `bootForLease`, the boot every lease grant of a shut-down device takes.
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    const firstAddress = ready.address;
    const shutdown = await shutdownDevice(harness, ready);
    const claim = harness.claims.tryClaim(shutdown.id, "boot");
    if (claim === undefined) throw new Error("expected boot claim");

    const handoff = await harness.lifecycle.bootForLease(shutdown, claim);
    handoff?.claim.release();

    expect(firstAddress).toBeDefined();
    expect(handoff?.device.address).toBeDefined();
    expect(handoff?.device.address).not.toBe(firstAddress);
    expect(harness.registry.snapshot.devices[0]?.address).toBe(handoff?.device.address);
    // The ownership identity is not a per-boot fact and must not drift with the address.
    expect(handoff?.device.driverDeviceId).toBe(ready.driverDeviceId);
  });

  it("bootWarm makes a shut-down device ready and ends the boot claim, where bootForLease keeps it", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    const shutdown = await shutdownDevice(harness, ready);
    const leaseClaim = harness.claims.tryClaim(shutdown.id, "boot");
    if (leaseClaim === undefined) throw new Error("expected boot claim");

    const handoff = await harness.lifecycle.bootForLease(shutdown, leaseClaim);

    expect(handoff?.device.state).toBe("ready");
    expect(harness.claims.isClaimed(shutdown.id)).toBe(true);
    handoff?.claim.release();
    const again = await shutdownDevice(harness, handoff?.device ?? ready);
    const warmClaim = harness.claims.tryClaim(again.id, "boot");
    if (warmClaim === undefined) throw new Error("expected boot claim");

    const booted = await harness.lifecycle.bootWarm(again, warmClaim);

    expect(booted).toMatchObject({ id: shutdown.id, state: "ready" });
    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.claims.isClaimed(shutdown.id)).toBe(false);
  });

  it("bootWarm ends the boot claim and leaves the device shut down when the boot fails", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    const shutdown = await shutdownDevice(harness, ready);
    const claim = harness.claims.tryClaim(shutdown.id, "boot");
    if (claim === undefined) throw new Error("expected boot claim");
    harness.driver.failOn("makeReady", 2, new DriverCrashError("emulator would not start"));

    await expect(harness.lifecycle.bootWarm(shutdown, claim)).rejects.toThrow(
      "emulator would not start",
    );

    expect(harness.registry.snapshot.devices[0]?.state).toBe("shutdown");
    expect(harness.claims.isClaimed(shutdown.id)).toBe(false);
  });

  it("bootWarm does nothing for a device that is no longer shut down", async () => {
    const harness = await createHarness();
    const ready = await readyDevice(harness);
    const claim = harness.claims.tryClaim(ready.id, "boot");
    if (claim === undefined) throw new Error("expected boot claim");
    const makeReadyCalls = harness.driver.calls.filter((call) => call.operation === "makeReady");

    await expect(harness.lifecycle.bootWarm(ready, claim)).resolves.toBeUndefined();

    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toEqual(
      makeReadyCalls,
    );
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
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60_000,
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

  it("holds an exclusive claim while readying a provisioned device for a lease is in flight", async () => {
    // `readyProvisionedForLease` takes its own claim (no caller hands it one): a second readying of
    // the same device, or any other operation on it, must find the device claimed until the first
    // has committed `ready`.
    const harness = await createHarness();
    harness.driver.hangMakeReady();

    const readying = harness.lifecycle.readyProvisionedForLease(harness.device);
    const readyingState = promiseState(readying);
    await vi.waitFor(() =>
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1),
    );
    expect(harness.claims.isClaimed(harness.device.id)).toBe(true);
    await expect(
      harness.lifecycle.readyProvisionedForLease(harness.device),
    ).resolves.toBeUndefined();
    // Both checks above ran with the driver call still in flight, not after it had returned.
    expect(readyingState.state).toBe("pending");

    harness.driver.releaseMakeReady();
    await expect(readying).resolves.toMatchObject({ device: { state: "ready" } });
    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
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
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
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
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
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
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
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
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
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
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
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
        requesterId: "agent",
        ownerId: "agent",
        ttlMs: 60_000,
        ttlDeadline: 10_000,
      });

      await harness.lifecycle.recoverLeased(ready, lease.id);

      const recoveryCall = harness.driver.calls.filter((call) => call.operation === "makeReady")[
        harness.driver.calls.filter((call) => call.operation === "makeReady").length - 1
      ];
      expect(recoveryCall?.arguments[1]).toEqual({ mode: "full", purpose: "recover" });
    });
  });

  it("persists a driver's reported mode via the readyProvisionedForLease handoff path (#makeReadyForLease)", async () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const driver = new FakeDriver({ clock, mode: "slim", platform: "ios" });
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

    expect(handoff?.device).toMatchObject({ mode: "slim" });
  });

  it("bootForLease stores full, replacing a stored slim, when the driver reports no mode (#makeReadyForLease, shutdown path)", async () => {
    // A driver that reports no mode must not leave a previously stored "slim" on the record,
    // or a device that is no longer slim keeps reporting `mode: "slim"`.
    const harness = await createHarness();
    const ready = await harness.registry.transitionDevice(
      harness.device.id,
      "ready",
      { event: "device.ready", payload: { bootDuration: 0, deviceId: harness.device.id } },
      {
        address: harness.device.driverDeviceId,
        driverData: harness.device.driverData,
        mode: "slim",
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
    expect(shutdown.mode).toBe("slim");
    const claim = harness.claims.tryClaim(shutdown.id, "boot");
    if (claim === undefined) throw new Error("expected boot claim");

    // `harness.driver` (a plain `FakeDriver` with no `mode` option) reports no mode on this
    // boot -- the driver-side equivalent of a boot that did not slim.
    const handoff = await harness.lifecycle.bootForLease(shutdown, claim);

    expect(handoff?.device.mode).toBe("full");
  });

  it("readyProvisionedForLease stores full, replacing a stored slim, when the driver reports no mode (#makeReadyForLease, provisioning path)", async () => {
    // A device can't naturally re-enter "provisioning" once it leaves, so the persisted state is
    // seeded directly (as a restarted daemon would load it from disk) to exercise the same
    // provisioning-branch code path the "shutdown" test above covers for the other branch.
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
            mode: "slim",
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
    expect(device.mode).toBe("slim");

    const handoff = await lifecycle.readyProvisionedForLease(device);

    expect(handoff?.device.mode).toBe("full");
  });

  describe("device mode on makeReady", () => {
    const slimSpec = {
      mode: "slim",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    } as const;

    async function slimHarness() {
      const clock = new FakeClock(1_000);
      const eventBus = new EventBus(clock);
      const driver = new FakeDriver({ clock, platform: "ios", slimmableOsVersions: ["26.5"] });
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
      const driverDevice = await driver.provision(slimSpec);
      const device = await registry.registerDevice({
        driverData: driverDevice.driverData,
        driverDeviceId: driverDevice.deviceId,
        provisionDuration: 0,
        spec: slimSpec,
      });
      return { claims, device, driver, lifecycle, registry };
    }

    function makeReadyOptions(driver: FakeDriver): readonly unknown[] {
      return driver.calls
        .filter((call) => call.operation === "makeReady")
        .map((call) => call.arguments[1]);
    }

    it("passes a slim spec's mode to makeReady on a prepare boot, from provisioning and from shutdown", async () => {
      const harness = await slimHarness();

      const provisioned = await harness.lifecycle.readyProvisionedForLease(harness.device);
      if (provisioned === undefined) throw new Error("expected a ready device");
      provisioned.claim.release();
      const ready = provisioned.device;
      await harness.lifecycle.shutdown(ready, "test", "cleanup");
      const shutdown = harness.registry.snapshot.devices[0];
      if (shutdown === undefined) throw new Error("expected the device");
      const claim = harness.claims.tryClaim(shutdown.id, "boot");
      if (claim === undefined) throw new Error("expected boot claim");
      const handoff = await harness.lifecycle.bootForLease(shutdown, claim);

      expect(makeReadyOptions(harness.driver)).toEqual([
        { mode: "slim", purpose: "prepare" },
        { mode: "slim", purpose: "prepare" },
      ]);
      expect(ready.mode).toBe("slim");
      expect(handoff?.device.mode).toBe("slim");
    });

    it("passes a slim spec's mode on a recovery boot too, under purpose recover", async () => {
      const harness = await slimHarness();
      const provisioned = await harness.lifecycle.readyProvisionedForLease(harness.device);
      if (provisioned === undefined) throw new Error("expected a ready device");
      provisioned.claim.release();
      const ready = provisioned.device;
      const lease = await harness.registry.createLease({
        deviceId: ready.id,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 10_000,
        ttlMs: 60_000,
      });

      await harness.lifecycle.recoverLeased(ready, lease.id);

      expect(makeReadyOptions(harness.driver).at(-1)).toEqual({ mode: "slim", purpose: "recover" });
    });
  });
});

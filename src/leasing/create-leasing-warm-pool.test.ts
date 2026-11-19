import { describe, expect, it, vi } from "vitest";
import { CleanupReaper, DriverCrashError } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink, MemoryFilesystem } from "../ports/index.js";
import {
  gibibyte,
  request,
  config,
  createHarness,
  seedReady,
  flush,
  settledOrPending,
} from "./test-create-leasing.js";

describe("createLeasing warm pool", () => {
  const androidSpec = {
    physical: false,
    model: "Pixel 9",
    osVersion: "36",
    platform: "android",
  } as const;

  it("shuts down one of three ready devices with initiator warm-pool after daemon.started when maxRunning is 2", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 2 },
        maxRunning: 2,
      },
    });
    await seedReady(harness);
    await seedReady(harness);
    await seedReady(harness);

    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();

    const states = harness.registry.snapshot.devices.map((item) => item.state);
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(states.filter((state) => state === "shutdown")).toHaveLength(1);
    const shutdowns = harness.bus.replay().filter((event) => event.event === "device.shutdown");
    expect(shutdowns).toHaveLength(1);
    expect(shutdowns[0]).toMatchObject({ payload: { initiator: "warm-pool" } });
  });

  it("logs a warm pool shutdown that fails under the warm pool's own module and leaves the device ready", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    driver.failOn("shutdown", 1, new DriverCrashError("cannot stop it"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
      logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }),
    });
    await seedReady(harness);
    await seedReady(harness);

    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();

    expect(sink.records.filter((record) => record.level === "warn")).toMatchObject([
      { fields: { step: "shutdown" }, module: expect.stringContaining("warm-pool") },
    ]);
    expect(harness.registry.snapshot.devices.map((item) => item.state)).toEqual(["ready", "ready"]);
  });

  it("a nuke that deletes devices is not undone by the warm pool booting a released device back", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    await harness.engine.request(request, { ownerId: "held", requesterId: "held" });

    await harness.engine.nuke(true);
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
  });

  it("triggers no pool pass from a fact before daemon.started, and ends with one of two ready devices shut down at one running slot", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    await seedReady(harness);
    await seedReady(harness);

    harness.bus.emit(
      "device.deleted",
      { deviceId: "x", initiator: "test", physical: false },
      "test",
    );
    await harness.engine.settle();
    expect(harness.registry.snapshot.devices.map((item) => item.state)).toEqual(["ready", "ready"]);

    await harness.engine.convergeRunningCapacity();
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices.map((item) => item.state).sort()).toEqual([
      "ready",
      "shutdown",
    ]);
  });

  it("cancels the pool's tick when the engine is disposed", async () => {
    const harness = await createHarness();
    await harness.engine.convergeRunningCapacity();
    // why: the pool's tick and the seed settler's first check (ADR 0090); the daemon's stop cancels the settler's, dispose the pool's.
    expect(harness.clock.pendingTimerCount).toBe(2);

    harness.engine.dispose();

    expect(harness.clock.pendingTimerCount).toBe(1);
  });

  it("a nuke without --delete-devices leaves the released devices destroyed, not booted back by the pool", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    await harness.engine.convergeRunningCapacity();
    const held = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });

    await harness.engine.nuke(false);
    await harness.engine.settle();
    // why: Still inside idle.shutdownAfterMs of the forced release, and a fact that triggers a pass.
    harness.bus.emit(
      "cleanup.executed",
      { action: "shutdown", reason: "test", ruleName: "test", target: held.device.id },
      "test",
    );
    await harness.engine.settle();

    expect(
      harness.registry.snapshot.devices.find((item) => item.id === held.device.id)?.state,
    ).toBe("deleted");
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
  });

  it("accepts a new request again once a nuke has finished", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, { ownerId: "held", requesterId: "held" });

    await harness.engine.nuke(false);

    await expect(
      harness.engine.request(request, { ownerId: "after", requesterId: "after" }),
    ).resolves.toMatchObject({ lease: { requesterId: "after" } });
  });

  /**
   * why: a released virtual device is destroyed, never booted back, so the device the warm pool
   * boots is a shut-down one that never ended a lease, under a warm target of one.
   * Its boot is held on the clock, with room for a second device.
   */
  async function shutdownDeviceBooting(failBoot = false) {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      knownModels: ["iPhone 16"],
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
      warmPool: {
        targets: [{ count: 1, model: "iPhone 16", osVersion: "26.5", platform: "ios" }],
      },
    });
    const seeding = seedReady(harness);
    await flush();
    clock.advance(50);
    const seeded = await seeding;
    await harness.registry.transitionDevice(seeded.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: seeded.id, initiator: "test" },
    });
    if (failBoot) driver.failOn("makeReady", 2, new Error("boom"));
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await vi.waitFor(() =>
      expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2),
    );
    return { clock, driver, seeded, harness };
  }

  it("a nuke waits for a warm pool boot already in flight, then deletes the device", async () => {
    const { clock, driver, harness } = await shutdownDeviceBooting();

    const nuking = harness.engine.nuke(true);
    await flush();
    clock.advance(50);
    await nuking;
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
  });

  describe("a request for a device on its way", () => {
    it("a request arriving during a warm-pool boot that serves it is granted that device when the boot settles, without a device provisioned for it", async () => {
      const { clock, driver, seeded, harness } = await shutdownDeviceBooting();

      const second = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await flush();
      expect(await settledOrPending(second)).toBe("still pending");
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);

      clock.advance(50);
      await flush();
      // why: The pool's kick after its boot woke the request: it is granted without another clock tick.
      expect(await settledOrPending(second)).not.toBe("still pending");
      const granted = await second;

      // why: the granted device leaves the warm target short, so the pool provisions a
      // replacement of its own; none was provisioned for the request, which got the booting one.
      expect(granted.device.id).toBe(seeded.id);
      expect(harness.bus.replay().filter((event) => event.event === "device.ready")).toHaveLength(
        2,
      );
    });

    async function twoRoomsHarness(warmPoolEnabled: boolean) {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        latencyMs: { makeReady: 50 },
        platform: "ios",
      });
      const harness = await createHarness({
        driver,
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 3, maxRunning: 3 },
          maxRunning: 3,
        },
        warmPoolEnabled,
      });
      return { clock, driver, harness };
    }

    it("a request arriving while another request is creating its own device provisions its own device rather than waiting for that one", async () => {
      const { clock, driver, harness } = await twoRoomsHarness(true);

      const first = harness.engine.request(request, { ownerId: "a", requesterId: "a" });
      await vi.waitFor(() =>
        expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1),
      );
      const second = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await flush();
      // why: Before either boot ends: the second request did not wait for the first one's device.
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
      clock.advance(50);
      await flush();
      clock.advance(50);
      const granted = await Promise.all([first, second]);

      expect(granted[0].device.id).not.toBe(granted[1].device.id);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    });

    it("a request arriving while another request is booting a shut-down device provisions its own device rather than waiting for that one", async () => {
      const { clock, driver, harness } = await twoRoomsHarness(false);
      // why: a released virtual device is destroyed, so the shut-down device is seeded.
      const seeding = seedReady(harness);
      await flush();
      clock.advance(50);
      const held = await seeding;
      await harness.registry.transitionDevice(held.id, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: held.id, initiator: "test" },
      });

      const booting = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await vi.waitFor(() =>
        expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2),
      );
      const other = harness.engine.request(request, { ownerId: "c", requesterId: "c" });
      await flush();
      // why: Before either boot ends: the other request did not wait for the one booting.
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
      clock.advance(50);
      await flush();
      clock.advance(50);
      const granted = await Promise.all([booting, other]);

      expect(granted[0].device.id).toBe(held.id);
      expect(granted[1].device.id).not.toBe(held.id);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    });

    it("under noWait a request arriving during a warm-pool boot provisions its own device", async () => {
      const { clock, driver, seeded, harness } = await shutdownDeviceBooting();

      const second = harness.engine.request(request, {
        noWait: true,
        ownerId: "b",
        requesterId: "b",
      });
      await flush();
      clock.advance(50);
      const granted = await second;

      expect(granted.device.id).not.toBe(seeded.id);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    });

    it("a request waiting on a warm-pool boot that fails re-plans on the kick and boots the device the failed boot left", async () => {
      const { clock, driver, seeded, harness } = await shutdownDeviceBooting(true);

      const second = harness.engine.request(request, { ownerId: "b", requesterId: "b" });
      await flush();
      clock.advance(50);
      await flush();
      // why: The kick from the failed boot woke the request: it has started booting the device itself.
      expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(3);
      clock.advance(50);
      const granted = await second;
      await harness.engine.settle();

      // why: The failed boot left the device `shutdown` and unclaimed, so the request boots it itself.
      expect(granted.device.id).toBe(seeded.id);
      expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(3);
      expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    });
  });

  it("a release at the running cap with a class request waiting provisions a new device for it, the released one being destroyed", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.0"],
      clock,
      knownModels: ["iPhone 15", "iPhone 17"],
      modelClasses: { "iPhone 15": "phone", "iPhone 17": "phone" },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
      modelPreferences: { ios: { phone: ["iPhone 17", "iPhone 15"] } },
    });
    const iphone15 = await seedReady(harness, {
      physical: false,
      model: "iPhone 15",
      osVersion: "26.0",
      platform: "ios",
    });
    const holder = await harness.engine.request(
      { model: "iPhone 15", osVersion: "26.0", platform: "ios" },
      { ownerId: "holder", requesterId: "holder" },
    );
    expect(holder.device.id).toBe(iphone15.id);
    const waiter = harness.engine.request(
      { class: "phone", platform: "ios" },
      { ownerId: "waiter", requesterId: "waiter" },
    );
    await flush();
    expect(harness.engine.queueDepth).toBe(1);

    await harness.engine.release(holder.lease.id, "explicit");
    const granted = await waiter;
    await harness.engine.settle();

    expect(granted.device.id).not.toBe(iphone15.id);
    expect(granted.device.spec.model).toBe("iPhone 17");
    expect(harness.registry.snapshot.devices.find((item) => item.id === iphone15.id)?.state).toBe(
      "deleted",
    );
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
  });

  it("destroys a released iOS device instead of booting it back when the running limit has room", async () => {
    const driver = new FakeDriver({
      knownModels: ["iPhone 16"],
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const harness = await createHarness({ driver, startPool: true });
    const first = await harness.engine.request(request, { ownerId: "a", requesterId: "a" });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(
      harness.registry.snapshot.devices.find((item) => item.id === first.device.id)?.state,
    ).toBe("deleted");
    const releasedDriverId = harness.registry.snapshot.devices.find(
      (item) => item.id === first.device.id,
    )?.driverDeviceId;
    expect(
      driver.calls.filter(
        (call) =>
          call.operation === "makeReady" &&
          (call.arguments[0] as { readonly deviceId: string }).deviceId === releasedDriverId,
      ),
    ).toHaveLength(1);
  });

  it("with warmPool disabled a released fake iOS device and a released fake Android device are both deleted, with no reclaim", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 4,
      },
      warmPoolEnabled: false,
    });
    const iosLease = await harness.engine.request(request, { ownerId: "i", requesterId: "i" });
    const androidLease = await harness.engine.request(androidSpec, {
      ownerId: "a",
      requesterId: "a",
    });

    await harness.engine.release(iosLease.lease.id, "explicit");
    await harness.engine.release(androidLease.lease.id, "explicit");
    await harness.engine.settle();

    const state = (id: string) =>
      harness.registry.snapshot.devices.find((item) => item.id === id)?.state;
    expect(state(iosLease.device.id)).toBe("deleted");
    expect(state(androidLease.device.id)).toBe("deleted");
    const events = harness.bus.replay();
    expect(events.filter((event) => event.event === "device.reclaimed")).toEqual([]);
    expect(
      events.filter((event) => event.event === "device.deleted").map((event) => event.payload),
    ).toMatchObject([
      { deviceId: iosLease.device.id, initiator: "lease-end" },
      { deviceId: androidLease.device.id, initiator: "lease-end" },
    ]);
  });
});

describe("createLeasing queued device cleanup", () => {
  it("keeps an old shut-down device ready across reaper passes while its requester waits behind the queue head", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 16"],
      platform: "ios",
    });
    const android = new FakeDriver({
      availableOsVersions: ["35"],
      clock: new FakeClock(1_000),
      platform: "android",
    });
    const harness = await createHarness({
      driver,
      drivers: [driver, android],
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 3,
      },
    });
    const other = { model: "Pixel 9", osVersion: "35", platform: "android" } as const;
    await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
      ttlMs: 3_600_000,
    });
    // why: a released virtual device is destroyed, so the old shut-down device is seeded.
    const previous = await seedReady(harness, { ...other, physical: false }, "full", android);
    await harness.registry.transitionDevice(previous.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: previous.id, initiator: "test" },
    });
    harness.clock.advance(10_001);
    await harness.engine.convergeRunningCapacity();
    const pending = ["head", "behind"].map((requesterId, index) =>
      harness.engine
        .request(index === 0 ? request : other, {
          ownerId: requesterId,
          requesterId,
        })
        .catch((error: unknown) => error),
    );
    await flush();
    await harness.engine.core.passWarmPool();
    await harness.engine.settle();
    const state = () =>
      harness.registry.snapshot.devices.find((device) => device.id === previous.id)?.state;
    expect(harness.engine.waitingRequests().map((entry) => entry.requesterId)).toEqual([
      "head",
      "behind",
    ]);
    expect(state()).toBe("ready");
    const reaper = new CleanupReaper({
      clock: harness.clock,
      config: { ...config(), diskPressure: { freeBytesThreshold: 10 * gibibyte } },
      eventBus: harness.bus,
      executor: harness.engine.cleanup,
      filesystem: new MemoryFilesystem(),
      registry: harness.registry,
      targetedDevices: () => harness.engine.core.targetedDevices(),
    });
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        await reaper.run();
        await harness.engine.settle();
      }
      expect(
        harness.bus
          .replay()
          .filter(
            (event) =>
              event.event === "device.shutdown" &&
              event.payload.deviceId === previous.id &&
              event.payload.initiator === "cleanup-reaper",
          ),
        "a device booted for a queued requester must not be reaped",
      ).toEqual([]);
      expect(state()).toBe("ready");
      await harness.engine.cancelPending("behind");
      expect(
        [...(await harness.engine.core.targetedDevices())],
        "cancelling the waiter removes cleanup protection immediately",
      ).not.toContain(previous.id);
    } finally {
      reaper.dispose();
      await harness.engine.cancelPending("head");
      await harness.engine.cancelPending("behind");
      await Promise.all(pending);
      harness.engine.dispose();
    }
  });
});

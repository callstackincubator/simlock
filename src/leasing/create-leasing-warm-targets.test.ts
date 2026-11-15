import { describe, expect, it, vi } from "vitest";
import { DriverCrashError, type LeaseProgress } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { request, createHarness, seedReady, flush } from "./test-create-leasing.js";

describe("createLeasing warm targets", () => {
  const target = {
    count: 2,
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
  } as const;
  const roomy = {
    android: { maxDevices: 1, maxRunning: 1 },
    ios: { maxDevices: 4, maxRunning: 4 },
    maxRunning: 4,
  };
  const eventsNamed = (harness: Awaited<ReturnType<typeof createHarness>>, name: string) =>
    harness.bus.replay().filter((event) => event.event === name);

  async function drain(
    harness: Awaited<ReturnType<typeof createHarness>>,
    driverClock?: FakeClock,
    stepMs = 50,
  ) {
    for (let round = 0; round < 40; round += 1) {
      await flush();
      harness.clock.advance(stepMs);
      driverClock?.advance(stepMs);
    }
    await flush();
    await harness.engine.settle();
  }

  it("after daemon.started with a target of two and no devices, creates two devices one after the other, the second only after the first is ready", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();

    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await flush();
    // why: The first is mid-boot: created, not yet ready, and no second one started.
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);
    expect(eventsNamed(harness, "device.ready")).toHaveLength(0);
    await drain(harness, clock);

    const order = harness.bus
      .replay()
      .map((event) => event.event)
      .filter((name) => name === "device.provisioned" || name === "device.ready");
    expect(order).toEqual([
      "device.provisioned",
      "device.ready",
      "device.provisioned",
      "device.ready",
    ]);
    expect(harness.registry.snapshot.devices.map((device) => device.state)).toEqual([
      "ready",
      "ready",
    ]);
  });

  it("on a graceful drain finishes the creation in flight and creates no further device for the target", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { makeReady: 50 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await flush();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);

    const draining = harness.engine.core.drain();
    await drain(harness, clock);
    await draining;

    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);
    expect(harness.registry.snapshot.devices.map((device) => device.state)).toEqual(["ready"]);
  });

  it("creates no device for a target once the warm pool is closed for a stop", async () => {
    const harness = await createHarness({ limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();
    harness.engine.core.closeWarmPool();

    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);

    expect(eventsNamed(harness, "device.provisioned")).toEqual([]);
  });

  it("grants the first lease of the targeted kind from a ready device with no booting stage, then keeps the count by creating another", async () => {
    const harness = await createHarness({ limits: roomy, warmPool: { targets: [target] } });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);
    const progress: LeaseProgress[] = [];

    const granted = await harness.engine.request(request, {
      onProgress: (update) => progress.push(update),
      ownerId: "agent",
      requesterId: "agent",
      ttlMs: 3_600_000,
    });
    await drain(harness);

    expect(progress.map((update) => update.stage)).not.toContain("booting");
    expect(progress.map((update) => update.stage)).not.toContain("provisioning");
    expect(eventsNamed(harness, "lease.granted")[0]).toMatchObject({ payload: { source: "warm" } });
    const states = harness.registry.snapshot.devices.map((device) => device.state).sort();
    expect(states).toEqual(["leased", "ready", "ready"]);
    expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "26.5" });
  });

  it("makes one creation attempt per allowed attempt when every boot fails, and recovers when one succeeds", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("makeReady", 1, new DriverCrashError("no boot"));
    driver.failOn("makeReady", 2, new DriverCrashError("no boot"));
    const harness = await createHarness({
      driver,
      limits: roomy,
      warmPool: { targets: [{ ...target, count: 1 }] },
    });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);

    harness.clock.advance(60_000 - 1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(1);
    harness.clock.advance(1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(2);

    harness.clock.advance(2 * 60_000 - 1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(2);
    harness.clock.advance(1);
    await harness.engine.settle();
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(3);
    expect(
      harness.registry.snapshot.devices.filter((device) => device.state === "ready"),
    ).toHaveLength(1);
  });

  it("with a target naming an OS that is not installed, starts no install", async () => {
    const install = vi.fn(async () => ({ outcome: "installed" as const, version: "27.0" }));
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });
    const harness = await createHarness({
      components: { claimProvision: () => () => undefined, install },
      driver,
      limits: roomy,
      warmPool: { targets: [{ ...target, osVersion: "27.0" }] },
    });
    await harness.engine.convergeRunningCapacity();

    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);

    expect(install).not.toHaveBeenCalled();
    expect(eventsNamed(harness, "component.install-started")).toEqual([]);
    expect(driver.calls.filter((call) => call.operation === "installComponent")).toEqual([]);
    expect(harness.registry.snapshot.devices).toEqual([]);
  });

  it("under fresh identity, creates a device before any lease, and after that lease ends and the spent device is deleted, creates the next", async () => {
    const harness = await createHarness({
      identity: { android: "reusable", ios: "fresh" },
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 2,
      },
      warmPool: { targets: [{ ...target, count: 1 }] },
    });
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);
    const [first] = harness.registry.snapshot.devices;
    expect(harness.registry.snapshot.devices).toHaveLength(1);
    expect(first).toMatchObject({ leaseIdentity: "fresh", state: "ready" });

    const granted = await harness.engine.request(request, {
      ownerId: "a",
      requesterId: "a",
      ttlMs: 3_600_000,
    });
    expect(granted.device.id).toBe(first?.id);
    await harness.engine.release(granted.lease.id, "explicit");
    await drain(harness);

    const devices = harness.registry.snapshot.devices.filter(
      (device) => device.state !== "deleted",
    );
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === first?.id),
    ).toMatchObject({ state: "deleted" });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ leaseIdentity: "fresh", state: "ready" });
    expect(devices[0]?.id).not.toBe(first?.id);
    expect(eventsNamed(harness, "device.provisioned")).toHaveLength(2);
  });

  it("shuts a never-leased ready device no target counts down with initiator warm-pool once it has been idle past idle.shutdownAfterMs", async () => {
    const harness = await createHarness({ limits: roomy });
    const device = await seedReady(harness);
    await harness.engine.convergeRunningCapacity();

    // why: a pass runs on a trigger, and the periodic tick is 30 s away: a daemon.started fact is one
    // at the threshold and one millisecond past it.
    harness.clock.advance(10_000);
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);
    expect(harness.registry.snapshot.devices.find((item) => item.id === device.id)?.state).toBe(
      "ready",
    );
    expect(eventsNamed(harness, "device.shutdown")).toEqual([]);

    harness.clock.advance(1);
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);

    expect(harness.registry.snapshot.devices.find((item) => item.id === device.id)?.state).toBe(
      "shutdown",
    );
    expect(eventsNamed(harness, "device.shutdown")).toMatchObject([
      { payload: { deviceId: device.id, initiator: "warm-pool" } },
    ]);
  });

  it("keeps a never-leased ready device a target counts past idle.shutdownAfterMs", async () => {
    const harness = await createHarness({
      limits: roomy,
      warmPool: { targets: [{ ...target, count: 1 }] },
    });
    const device = await seedReady(harness);
    await harness.engine.convergeRunningCapacity();
    harness.bus.emit("daemon.started", { configSnapshot: {}, version: "test" }, "test");
    await drain(harness);

    harness.clock.advance(5 * 60_000);
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices.find((item) => item.id === device.id)?.state).toBe(
      "ready",
    );
    expect(eventsNamed(harness, "device.shutdown")).toEqual([]);
    // why: The reaper reads the same set through the core, so it leaves the device alone too.
    expect([...(await harness.engine.core.targetedDevices())]).toEqual([device.id]);
  });
});

describe("createLeasing's port for the warm pool", () => {
  it("answers each platform's configured default mode, and full where none is configured", async () => {
    const { engine } = await createHarness({ defaultModes: { ios: "slim" } });

    const { defaultMode } = engine.leasing.corePorts.warmPoolDemand;

    expect([defaultMode("ios"), defaultMode("android")]).toEqual(["slim", "full"]);
  });
});

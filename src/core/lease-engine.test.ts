import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import {
  BootTimeoutError,
  type Config,
  DriverCrashError,
  FakeDriver,
  HeldLeaseRenewalError,
  LeaseEngine,
  NoCapacityError,
  QueueTimeoutError,
  Registry,
  RequesterAlreadyLeasedError,
} from "./index.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.pitlane/state.json";
const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function config(overrides: Partial<Config["lease"]> = {}): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 100, heldTtlBackstopMs: 100, ...overrides },
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    warmPool: {},
  };
}

async function createHarness(
  options: {
    readonly driver?: FakeDriver;
    readonly drivers?: readonly FakeDriver[];
    readonly lease?: Partial<Config["lease"]>;
    readonly limits?: Config["limits"];
  } = {},
) {
  const clock = new FakeClock(1_000);
  const filesystem = new MemoryFilesystem();
  const bus = new EventBus(clock);
  const driver =
    options.driver ?? new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  let nextId = 1;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem,
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const baseConfig = config(options.lease);
  const engineConfig: Config =
    options.limits === undefined ? baseConfig : { ...baseConfig, limits: options.limits };
  const engine = new LeaseEngine({
    clock,
    config: engineConfig,
    drivers: options.drivers ?? [driver],
    eventBus: bus,
    idGenerator: { generate: () => `request-${nextId++}` },
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  });

  return { bus, clock, driver, engine, registry };
}

async function seedReady(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: import("./index.js").DeviceSpec = request,
) {
  const driverDevice = await harness.driver.provision(spec);
  const device = await harness.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  return harness.registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
}

async function flush(): Promise<void> {
  for (let count = 0; count < 20; count += 1) {
    await Promise.resolve();
  }
}

describe("LeaseEngine", () => {
  it("enforces global and platform limits together across drivers", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const holder = await harness.engine.request(request, {
      mode: "held",
      requesterId: "ios-holder",
    });
    const androidRequest = { model: "Pixel 9", osVersion: "36", platform: "android" } as const;

    await expect(
      harness.engine.request(androidRequest, {
        mode: "held",
        noWait: true,
        requesterId: "android-no-wait",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(android.calls.filter((call) => call.operation === "provision")).toHaveLength(0);
    expect(android.calls.filter((call) => call.operation === "makeReady")).toHaveLength(0);

    await harness.engine.release(holder.lease.id, "explicit");
    await expect(
      harness.engine.request(androidRequest, { mode: "held", requesterId: "android" }),
    ).resolves.toMatchObject({ device: { spec: { platform: "android" } } });
  });

  it("converges startup excess through shutdown without touching leases and is idempotent", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const leasedDevice = await seedReady(harness);
    const unleasedDevice = await seedReady(harness);
    await harness.registry.createLease({
      deviceId: leasedDevice.id,
      mode: "held",
      requesterId: "active",
      ttlDeadline: 2_000,
    });

    await harness.engine.convergeRunningCapacity();
    await harness.engine.convergeRunningCapacity();

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: leasedDevice.id, state: "leased" },
      { id: unleasedDevice.id, state: "shutdown" },
    ]);
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);
    expect(harness.engine.runningCapacity.global.overLimit).toBe(false);
  });

  it("reports unavoidable leased running overage", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 3, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    for (const requesterId of ["one", "two"]) {
      const device = await seedReady(harness);
      await harness.registry.createLease({
        deviceId: device.id,
        mode: "held",
        requesterId,
        ttlDeadline: 2_000,
      });
    }

    await harness.engine.convergeRunningCapacity();

    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(0);
    expect(harness.engine.runningCapacity.global.overLimit).toBe(true);
    await expect(
      harness.engine.request(request, { mode: "held", noWait: true, requesterId: "three" }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("holds one running reservation across provision and readiness", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    driver.hangMakeReady();
    const harness = await createHarness({ driver });

    const first = harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    const second = harness.engine.request(request, { mode: "held", requesterId: "agent-2" });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
    expect(harness.engine.runningCapacity.global.reserved).toBe(1);
    expect(harness.engine.queueDepth).toBe(1);

    driver.releaseMakeReady();
    const grant = await first;
    await harness.engine.release(grant.lease.id, "explicit");
    await expect(second).resolves.toMatchObject({ lease: { requesterId: "agent-2" } });
  });

  it("starts exactly one of two existing shutdown devices at running capacity one", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const harness = await createHarness({ driver });
    for (let index = 0; index < 2; index += 1) {
      const device = await seedReady(harness);
      await harness.registry.transitionDevice(device.id, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: device.id, initiator: "test" },
      });
    }
    driver.hangMakeReady();

    void harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    void harness.engine.request(request, { mode: "held", requesterId: "agent-2" });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
    expect(harness.engine.queueDepth).toBe(1);
    driver.releaseMakeReady();
  });

  it("serializes simultaneous requests so one device of capacity starts exactly one provision", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { provision: 20 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });

    const first = harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    const second = harness.engine.request(request, { mode: "held", requesterId: "agent-2" });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "resolveSpec")).toHaveLength(2);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    clock.advance(20);
    await first;
    await flush();
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);

    await harness.engine.release((await first).lease.id, "explicit");
    await expect(second).resolves.toMatchObject({ lease: { requesterId: "agent-2" } });
  });

  it("grants an existing matching ready device and does not match a different spec", async () => {
    const harness = await createHarness();
    const matching = await seedReady(harness);
    await seedReady(harness, { model: "iPhone SE", osVersion: "26.5", platform: "ios" });
    const progress: string[] = [];

    const grant = await harness.engine.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
    });

    expect(grant.device.id).toBe(matching.id);
    expect(progress).toEqual([]);
    expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
  });

  it("provisions and makes a device ready when capacity is available, returning progress estimates", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });

    const progress: string[] = [];
    const grant = await harness.engine.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
    });

    expect(grant).toMatchObject({
      device: { spec: request, state: "leased" },
      timing: { estimatedBootMs: 20, estimatedProvisionMs: 10, estimatedReadyMs: 30 },
    });
    expect(driver.calls.map((call) => call.operation)).toEqual([
      "resolveSpec",
      "provision",
      "makeReady",
    ]);
  });

  it("reports only the selected work as it begins", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 15 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    const provisioned: string[] = [];

    const provisionedGrant = await harness.engine.request(request, {
      mode: "held",
      onProgress: (progress) => provisioned.push(progress.stage),
      requesterId: "provisioned",
    });
    expect(provisioned).toEqual(["provisioning", "booting"]);
    await harness.engine.release(provisionedGrant.lease.id, "explicit");

    const shutdown = harness.registry.snapshot.devices[0];
    if (shutdown === undefined) throw new Error("Expected provisioned device");
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    const booted: string[] = [];
    await harness.engine.request(request, {
      mode: "held",
      onProgress: (progress) => booted.push(progress.stage),
      requesterId: "shutdown",
    });
    expect(booted).toEqual(["booting"]);
  });

  it("reports queue insertion without speculative work and isolates callback failures", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const harness = await createHarness({ driver });
    const holder = await harness.engine.request(request, { mode: "held", requesterId: "holder" });
    const progress: string[] = [];
    const queued = harness.engine.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "queued",
    });
    await flush();
    expect(progress).toEqual(["queued"]);

    await expect(
      harness.engine.request(request, {
        mode: "held",
        noWait: true,
        onProgress: () => progress.push("unexpected"),
        requesterId: "no-wait",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(progress).toEqual(["queued"]);

    await harness.engine.release(holder.lease.id, "explicit");
    await queued;

    const callbackFailure = await createHarness();
    await expect(
      callbackFailure.engine.request(request, {
        mode: "held",
        onProgress: () => {
          throw new Error("client disconnected");
        },
        requesterId: "throwing-callback",
      }),
    ).resolves.toMatchObject({ device: { state: "leased" } });
    expect(callbackFailure.driver.calls.map((call) => call.operation)).toContain("makeReady");
  });

  it("detaches progress from a queued request without cancelling its lease", async () => {
    const harness = await createHarness();
    const holder = await harness.engine.request(request, { mode: "held", requesterId: "holder" });
    const progress: string[] = [];
    const queued = harness.engine.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "queued",
    });
    await flush();

    await harness.engine.detachQueuedProgress("queued");
    await harness.engine.release(holder.lease.id, "explicit");
    await expect(queued).resolves.toMatchObject({ lease: { requesterId: "queued" } });
    expect(progress).toEqual(["queued"]);
  });

  it("reclaims a matching warm device before granting it and reports its reclaim estimate", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { reclaim: 15 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    const device = await seedReady(harness);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "former-agent",
      ttlDeadline: 2_000,
    });
    await harness.registry.beginRelease(lease.id);
    await harness.registry.transitionDevice(device.id, "warm", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 0, strategy: "wipe" },
    });

    const progress: string[] = [];
    const grant = await harness.engine.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
    });

    expect(grant).toMatchObject({
      device: { id: device.id, state: "leased" },
      timing: { estimatedReclaimMs: 15, estimatedReadyMs: 15 },
    });
    expect(driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(progress).toEqual(["reclaiming"]);
  });

  it("reports booting only after a warm reclaim actually returns shutdown", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, reclaim: 15 },
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    const device = await seedReady(harness);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      mode: "held",
      requesterId: "former-agent",
      ttlDeadline: 2_000,
    });
    await harness.registry.beginRelease(lease.id);
    await harness.registry.transitionDevice(device.id, "warm", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 0, strategy: "wipe" },
    });
    const progress: string[] = [];

    await harness.engine.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
    });

    expect(progress).toEqual(["reclaiming", "booting"]);
  });

  it("queues at capacity in FIFO order across three waiters", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    const second = harness.engine.request(request, { mode: "held", requesterId: "agent-2" });
    const third = harness.engine.request(request, { mode: "held", requesterId: "agent-3" });
    const fourth = harness.engine.request(request, { mode: "held", requesterId: "agent-4" });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");
    const secondGrant = await second;
    await harness.engine.release(secondGrant.lease.id, "explicit");
    const thirdGrant = await third;
    await harness.engine.release(thirdGrant.lease.id, "explicit");
    const fourthGrant = await fourth;

    expect([secondGrant, thirdGrant, fourthGrant].map((grant) => grant.lease.requesterId)).toEqual([
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
  });

  it("wakes exactly the queue head on release and reuses its reclaimed ready device", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    const second = harness.engine.request(request, { mode: "held", requesterId: "agent-2" });
    const third = harness.engine.request(request, { mode: "held", requesterId: "agent-3" });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");
    const secondGrant = await second;
    await flush();

    expect(secondGrant.device.id).toBe(first.device.id);
    expect(harness.registry.snapshot.leases).toHaveLength(1);
    expect(harness.registry.snapshot.leases[0]?.requesterId).toBe("agent-2");
    expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    await harness.engine.release(secondGrant.lease.id, "explicit");
    await expect(third).resolves.toMatchObject({ lease: { requesterId: "agent-3" } });
  });

  it("boots a reclaimed shutdown device for the queue head instead of deadlocking at capacity", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      reclaimResult: "shutdown",
    });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    const queued = harness.engine.request(request, { mode: "held", requesterId: "agent-2" });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");

    await expect(queued).resolves.toMatchObject({ device: { id: first.device.id } });
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2);
  });

  it("rejects a no-wait request at capacity with a typed error", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });

    await expect(
      harness.engine.request(request, { mode: "held", noWait: true, requesterId: "agent-2" }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("rejects a timed-out queue entry and skips it on a later release", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    const progress: string[] = [];
    const timedOut = harness.engine.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-2",
      timeoutMs: 10,
    });
    const next = harness.engine.request(request, { mode: "held", requesterId: "agent-3" });
    await flush();

    harness.clock.advance(10);
    await expect(timedOut).rejects.toBeInstanceOf(QueueTimeoutError);
    expect(progress).toEqual(["queued"]);
    await harness.engine.release(first.lease.id, "explicit");

    await expect(next).resolves.toMatchObject({ lease: { requesterId: "agent-3" } });
  });

  it("expires held leases, serves the queue, extends detached leases, and rejects held renewal", async () => {
    const harness = await createHarness({ lease: { detachedTtlMs: 20, heldTtlBackstopMs: 10 } });
    const held = await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });
    await expect(harness.engine.renew(held.lease.id, 20)).rejects.toBeInstanceOf(
      HeldLeaseRenewalError,
    );
    const queued = harness.engine.request(request, { mode: "held", requesterId: "agent-2" });
    await flush();

    harness.clock.advance(10);
    await flush();
    await expect(queued).resolves.toMatchObject({ lease: { requesterId: "agent-2" } });

    const detachedHarness = await createHarness({ lease: { detachedTtlMs: 20 } });
    const detached = await detachedHarness.engine.request(request, {
      mode: "detached",
      requesterId: "agent-3",
    });
    const renewed = await detachedHarness.engine.renew(detached.lease.id, 30);
    detachedHarness.clock.advance(20);
    await flush();

    expect(renewed.ttlDeadline).toBe(1_030);
    expect(detachedHarness.registry.snapshot.leases).toHaveLength(1);
  });

  it("enforces one active request or lease per requester, then permits another after release", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });

    await expect(
      harness.engine.request(request, { mode: "held", requesterId: "agent-1" }),
    ).rejects.toBeInstanceOf(RequesterAlreadyLeasedError);
    await harness.engine.release(first.lease.id, "explicit");
    expect(harness.clock.pendingTimerCount).toBe(0);
    await expect(
      harness.engine.request(request, { mode: "held", requesterId: "agent-1" }),
    ).resolves.toMatchObject({ lease: { requesterId: "agent-1" } });
  });

  it("retries after a provision failure without leaking capacity", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
    const harness = await createHarness({ driver });

    const grant = await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });

    expect(grant.device.state).toBe("leased");
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    expect(
      harness.registry.snapshot.devices.filter((device) => device.state !== "deleted"),
    ).toHaveLength(1);
  });

  it("destroys a registered device and returns BootTimeoutError when readiness fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("makeReady", 1, new Error("boot failed"));
    const harness = await createHarness({ driver });

    await expect(
      harness.engine.request(request, { mode: "held", requesterId: "agent-1" }),
    ).rejects.toBeInstanceOf(BootTimeoutError);

    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(driver.calls.map((call) => call.operation)).toContain("destroy");
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it("emits committed happy-path facts in lifecycle order", async () => {
    const harness = await createHarness();

    await harness.engine.request(request, { mode: "held", requesterId: "agent-1" });

    expect(harness.bus.replay().map((event) => event.event)).toEqual([
      "lease.requested",
      "device.provisioned",
      "device.ready",
      "lease.granted",
    ]);
  });
});

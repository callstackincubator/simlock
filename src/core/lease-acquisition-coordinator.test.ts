import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import { CapacityCoordinator, createCapacityStrategy } from "./capacity/index.js";
import type { Config } from "./config.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import { DriverCatalog } from "./driver-catalog.js";
import { DriverCrashError } from "./driver.js";
import type { DeviceSpec } from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import { LeaseAcquisitionCoordinator, NoCapacityError } from "./lease-acquisition-coordinator.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";
import { QueueTimeoutError, WaitQueue } from "./wait-queue.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";
const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function config(maxDevices = 1): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    downloads: { acceptAndroidLicenses: false, policy: "on-request", timeoutMs: 1_200_000 },
    eventBuffer: { capacity: 100 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 100, heldTtlBackstopMs: 100, heartbeatIntervalMs: 25 },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices, maxRunning: 1 },
          ios: { maxDevices, maxRunning: 1 },
          maxRunning: 1,
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
  options: { readonly drivers?: readonly FakeDriver[]; readonly maxDevices?: number } = {},
) {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver =
    options.drivers?.[0] ??
    new FakeDriver({ clock, platform: "ios", availableOsVersions: ["26.5"] });
  const drivers = options.drivers ?? [driver];
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem: new MemoryFilesystem(),
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const decisions = new SerializedDecision();
  const claims = new DeviceOperationClaims();
  const catalog = new DriverCatalog(drivers);
  const capacity = new CapacityCoordinator(
    createCapacityStrategy(
      config(options.maxDevices).capacity,
      new FakeSystemStats({
        cpuCount: 8,
        freeRamBytes: 32 * gibibyte,
        totalRamBytes: 32 * gibibyte,
      }),
    ),
  );
  const lifecycle = new ManagedDeviceLifecycle(catalog, registry, decisions, claims, clock);
  const provisioner = new DeviceProvisioner({ catalog, clock, decisions, lifecycle, registry });
  const expiry = new LeaseExpiryScheduler(clock, async () => undefined);
  const leases = new LeaseLifecycle({
    clock,
    eventBus: bus,
    expiryScheduler: expiry,
    registry,
    ttl: { detachedMs: 100, heldBackstopMs: 100 },
  });
  let coordinator: LeaseAcquisitionCoordinator | undefined;
  const queue = new WaitQueue({
    clock,
    idGenerator: { generate: () => `request-${nextId++}` },
    onTimeout: (waiter) => {
      bus.emit("lease.rejected", { requestSpec: waiter.request, reason: "timeout" }, "wait-queue");
      coordinator?.kick();
    },
  });
  coordinator = new LeaseAcquisitionCoordinator({
    claims,
    decisions,
    drivers: catalog,
    eventBus: bus,
    leases,
    lifecycle,
    planner: new AcquisitionPlanner(capacity, claims),
    provisioner,
    queue,
    registry,
  });
  return { bus, clock, coordinator, driver, registry };
}

async function seedReady(
  harness: Awaited<ReturnType<typeof createHarness>>,
  spec: DeviceSpec = request,
) {
  const driverDevice = await harness.driver.provision(spec);
  const provisioned = await harness.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  await harness.driver.makeReady(driverDevice);
  return harness.registry.transitionDevice(provisioned.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: provisioned.id },
  });
}

async function flush(): Promise<void> {
  for (let count = 0; count < 20; count += 1) await Promise.resolve();
}

describe("LeaseAcquisitionCoordinator", () => {
  it("admits one requester and rejects an active or pending duplicate", async () => {
    const harness = await createHarness();
    const granted = await harness.coordinator.request(request, {
      mode: "held",
      requesterId: "agent",
    });

    await expect(
      harness.coordinator.request(request, { mode: "held", requesterId: "agent" }),
    ).rejects.toMatchObject({
      existingLeaseId: granted.lease.id,
      message: expect.stringContaining(granted.lease.id),
      name: "RequesterAlreadyLeasedError",
    });
    expect(granted.lease.requesterId).toBe("agent");
  });

  it("rejects missing drivers and unresolved specs without leaving pending demand", async () => {
    const empty = await createHarness({ drivers: [] });
    await expect(
      empty.coordinator.request(request, { mode: "held", requesterId: "missing-driver" }),
    ).rejects.toThrow("No driver registered");
    expect(empty.coordinator.queueDepth).toBe(0);

    const harness = await createHarness();
    await expect(
      harness.coordinator.request(
        { ...request, osVersion: "99" },
        { mode: "held", requesterId: "bad-spec" },
      ),
    ).rejects.toThrow("Runtime missing");
    expect(harness.coordinator.queueDepth).toBe(0);
  });

  it("enforces FIFO, rejects no-wait demand, and skips timed-out waiters", async () => {
    const harness = await createHarness();
    const first = await harness.coordinator.request(request, {
      mode: "held",
      requesterId: "first",
    });
    const timedOut = harness.coordinator.request(request, {
      mode: "held",
      requesterId: "timed-out",
      timeoutMs: 10,
    });
    const next = harness.coordinator.request(request, { mode: "held", requesterId: "next" });
    await flush();
    await expect(
      harness.coordinator.request(request, { mode: "held", noWait: true, requesterId: "no-wait" }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    harness.clock.advance(10);
    await expect(timedOut).rejects.toBeInstanceOf(QueueTimeoutError);
    await harness.registry.beginRelease(first.lease.id);
    const device = harness.registry.snapshot.devices[0];
    if (device === undefined) throw new Error("expected device");
    await harness.registry.transitionDevice(device.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 0, strategy: "wipe" },
    });
    harness.coordinator.kick();
    await expect(next).resolves.toMatchObject({ lease: { requesterId: "next" } });
  });

  it("grants an existing ready device and preserves request progress semantics", async () => {
    const harness = await createHarness();
    const ready = await seedReady(harness);
    const progress: string[] = [];

    const grant = await harness.coordinator.request(request, {
      mode: "held",
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent",
    });

    expect(grant.device.id).toBe(ready.id);
    expect(progress).toEqual([]);
  });

  it("retries provisioning once and rejects boot failures", async () => {
    const harness = await createHarness();
    harness.driver.failOn("provision", 1, new DriverCrashError("temporary"));
    const grant = await harness.coordinator.request(request, {
      mode: "held",
      requesterId: "retry",
    });
    expect(grant.device.state).toBe("leased");
    expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);

    const failing = await createHarness();
    failing.driver.failOn("makeReady", 1, new DriverCrashError("boot failure"));
    await expect(
      failing.coordinator.request(request, { mode: "held", requesterId: "boot-failure" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });
  });

  it("boots shutdown inventory and evicts managed demand before provisioning", async () => {
    const bootHarness = await createHarness();
    const ready = await seedReady(bootHarness);
    await bootHarness.driver.shutdown({
      address: ready.address ?? "",
      deviceId: ready.driverDeviceId,
      driverData: ready.driverData,
    });
    await bootHarness.registry.transitionDevice(ready.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: ready.id, initiator: "test" },
    });
    const progress: string[] = [];
    await expect(
      bootHarness.coordinator.request(request, {
        mode: "held",
        onProgress: (update) => progress.push(update.stage),
        requesterId: "boot",
      }),
    ).resolves.toMatchObject({ device: { id: ready.id } });
    expect(progress).toEqual(["booting"]);

    const eviction = await createHarness();
    const old = await seedReady(eviction, { ...request, model: "iPhone SE" });
    await expect(
      eviction.coordinator.request(request, { mode: "held", requesterId: "new-spec" }),
    ).resolves.toMatchObject({ device: { spec: request } });
    expect(eviction.registry.snapshot.devices.find((device) => device.id === old.id)?.state).toBe(
      "deleted",
    );
  });

  it("drains a cancelled in-flight boot before maintenance returns", async () => {
    const harness = await createHarness();
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    harness.driver.hangMakeReady();
    const makeReadyBeforeRequest = harness.driver.calls.filter(
      (call) => call.operation === "makeReady",
    ).length;

    const acquisition = harness.coordinator.request(request, {
      mode: "held",
      requesterId: "drained",
    });
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      makeReadyBeforeRequest + 1,
    );

    let maintenanceReturned = false;
    const maintenance = harness.coordinator.beginMaintenance().then(() => {
      maintenanceReturned = true;
    });
    await flush();
    expect(maintenanceReturned).toBe(false);
    expect(harness.registry.snapshot.leases).toEqual([]);
    await expect(
      harness.coordinator.request(request, { mode: "held", requesterId: "during-maintenance" }),
    ).rejects.toMatchObject({ name: "NukeCancelledError" });

    harness.driver.releaseMakeReady();
    await maintenance;
    await expect(acquisition).rejects.toMatchObject({ name: "NukeCancelledError" });
    expect(harness.registry.snapshot.leases).toEqual([]);

    await harness.coordinator.endMaintenance();
  });

  it("coalesces simultaneous kicks for the same queued waiter", async () => {
    const harness = await createHarness({ maxDevices: 2 });
    const first = await harness.coordinator.request(request, {
      mode: "held",
      requesterId: "first",
    });
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });

    const queued = harness.coordinator.request(request, { mode: "held", requesterId: "queued" });
    await flush();
    harness.driver.hangMakeReady();
    await harness.registry.beginRelease(first.lease.id);
    const leased = harness.registry.snapshot.devices.find(
      (candidate) => candidate.id === first.device.id,
    );
    if (leased === undefined) throw new Error("expected leased device");
    await harness.registry.transitionDevice(leased.id, "shutdown", {
      event: "device.reclaimed",
      payload: { deviceId: leased.id, duration: 0, strategy: "wipe" },
    });

    const makeReadyBeforeKick = harness.driver.calls.filter(
      (call) => call.operation === "makeReady",
    ).length;
    harness.coordinator.kick();
    harness.coordinator.kick();
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      makeReadyBeforeKick + 1,
    );

    let maintenanceReturned = false;
    const maintenance = harness.coordinator.beginMaintenance().then(() => {
      maintenanceReturned = true;
    });
    await flush();
    expect(maintenanceReturned).toBe(false);
    harness.driver.releaseMakeReady();
    await maintenance;
    await expect(queued).rejects.toMatchObject({ name: "NukeCancelledError" });
    await harness.coordinator.endMaintenance();
  });

  it("cancels a queued request, emits lease.rejected(cancelled), and frees the requester immediately", async () => {
    const harness = await createHarness();
    await harness.coordinator.request(request, { mode: "held", requesterId: "first" });
    const queued = harness.coordinator.request(request, { mode: "held", requesterId: "queued" });
    await flush();
    expect(harness.coordinator.queueDepth).toBe(1);

    const rejections: unknown[] = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejections.push(envelope.payload));

    await expect(harness.coordinator.cancelPending("queued")).resolves.toBe("cancelled");
    await expect(queued).rejects.toMatchObject({ name: "RequestCancelledError" });
    expect(harness.coordinator.queueDepth).toBe(0);
    expect(rejections).toContainEqual({ requestSpec: request, reason: "cancelled" });

    // No capacity remains (still held by "first"), but crucially this is NoCapacityError,
    // not RequesterAlreadyLeasedError -- the cancelled requester is no longer pending.
    await expect(
      harness.coordinator.request(request, { mode: "held", noWait: true, requesterId: "queued" }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("reports not-found for a requester with no pending waiter", async () => {
    const harness = await createHarness();
    await expect(harness.coordinator.cancelPending("nobody")).resolves.toBe("not-found");
  });

  it("reports not-cancellable while device work is already in flight, matching the queue timeout's envelope", async () => {
    const harness = await createHarness();
    const shutdown = await seedReady(harness);
    await harness.driver.shutdown({
      address: shutdown.address ?? "",
      deviceId: shutdown.driverDeviceId,
      driverData: shutdown.driverData,
    });
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    harness.driver.hangMakeReady();

    const acquisition = harness.coordinator.request(request, {
      mode: "held",
      requesterId: "booting",
    });
    await flush();

    await expect(harness.coordinator.cancelPending("booting")).resolves.toBe("not-cancellable");

    harness.driver.releaseMakeReady();
    await expect(acquisition).resolves.toMatchObject({ device: { id: shutdown.id } });
  });

  it("keeps admission closed until concurrent maintenance callers have all finished", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    await harness.coordinator.beginMaintenance();
    await harness.coordinator.endMaintenance();

    await expect(
      harness.coordinator.request(request, { mode: "held", requesterId: "still-maintained" }),
    ).rejects.toMatchObject({ name: "NukeCancelledError" });

    await harness.coordinator.endMaintenance();
    await expect(
      harness.coordinator.request(request, { mode: "held", requesterId: "reopened" }),
    ).resolves.toMatchObject({ lease: { requesterId: "reopened" } });
  });
});

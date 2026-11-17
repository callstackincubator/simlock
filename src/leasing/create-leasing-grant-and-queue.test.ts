import { describe, expect, it } from "vitest";
import {
  BootTimeoutError,
  type DeviceSpec,
  type DriverEstimate,
  DriverCrashError,
} from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import {
  request,
  createHarness,
  seedReady,
  flush,
  settledOrPending,
} from "./test-create-leasing.js";
import { NoCapacityError, QueueTimeoutError, RequestCancelledError } from "./index.js";

describe("createLeasing", () => {
  it("shuts down an unleased ready device over maxRunning at startup with initiator warm-pool, never a leased one, and is idempotent", async () => {
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
      requesterId: "active",
      ownerId: "active",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });

    await harness.engine.convergeRunningCapacity();
    await harness.engine.settle();
    await harness.engine.convergeRunningCapacity();
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: leasedDevice.id, state: "leased" },
      { id: unleasedDevice.id, state: "shutdown" },
    ]);
    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(1);
    expect(harness.engine.runningCapacity.global.overLimit).toBe(false);
    expect(harness.bus.replay().filter((event) => event.event === "device.shutdown")).toMatchObject(
      [{ payload: { deviceId: unleasedDevice.id, initiator: "warm-pool" } }],
    );
  });

  it("retains in-limit warm devices at startup and never boots shutdown inventory", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
    });
    const warm = await seedReady(harness);
    const shutdown = await seedReady(harness);
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    const callsBefore = harness.driver.calls.length;

    await harness.engine.convergeRunningCapacity();

    expect(harness.registry.snapshot.devices.find((item) => item.id === warm.id)?.state).toBe(
      "ready",
    );
    expect(harness.registry.snapshot.devices.find((item) => item.id === shutdown.id)?.state).toBe(
      "shutdown",
    );
    expect(harness.driver.calls.slice(callsBefore).map((call) => call.operation)).toEqual([
      "listManaged",
      "listSources",
    ]);
  });

  it("shuts an orphaned reclaiming device down and destroys it through its driver", async () => {
    const harness = await createHarness();
    const device = await seedReady(harness);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      requesterId: "former",
      ownerId: "former",
      ttlMs: 60_000,
      ttlDeadline: 2_000,
    });
    await harness.registry.beginRelease(lease.id);

    await harness.engine.convergeRunningCapacity();

    expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
    const operations = harness.driver.calls.map((call) => call.operation);
    expect(operations).toContain("shutdown");
    expect(operations).toContain("destroy");
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
        ownerId: requesterId,
        requesterId,
        ttlMs: 60_000,
        ttlDeadline: 2_000,
      });
    }

    await harness.engine.convergeRunningCapacity();

    expect(harness.driver.calls.filter((call) => call.operation === "shutdown")).toHaveLength(0);
    expect(harness.engine.runningCapacity.global.overLimit).toBe(true);
    await expect(
      harness.engine.request(request, {
        noWait: true,
        ownerId: "three",
        requesterId: "three",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("holds one running reservation across provision and readiness", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
    });
    driver.hangMakeReady();
    const harness = await createHarness({ driver });

    const first = harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const second = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);
    expect(harness.engine.runningCapacity.global.reserved).toBe(1);
    expect(harness.engine.queueDepth).toBe(1);

    driver.releaseMakeReady();
    const grant = await first;
    await harness.engine.release(grant.lease.id, "explicit");
    await expect(second).resolves.toMatchObject({
      lease: { ownerId: "agent-2", requesterId: "agent-2" },
    });
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
    const seededBoots = driver.calls.filter((call) => call.operation === "makeReady").length;
    driver.hangMakeReady();

    void harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    void harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
      seededBoots + 1,
    );
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

    const first = harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const second = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    expect(harness.engine.queueDepth).toBe(1);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
    clock.advance(20);
    await first;
    await flush();
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);

    const released = (await first).device.id;
    await harness.engine.release((await first).lease.id, "explicit");
    await flush();
    clock.advance(20);
    const granted = await second;
    expect(granted).toMatchObject({ lease: { ownerId: "agent-2", requesterId: "agent-2" } });
    expect(granted.device.id).not.toBe(released);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
  });

  it("grants an existing matching ready device and does not match a different spec", async () => {
    const harness = await createHarness();
    const matching = await seedReady(harness);
    await seedReady(harness, {
      physical: false,
      model: "iPhone SE",
      osVersion: "26.5",
      platform: "ios",
    });
    const progress: string[] = [];
    const provisions = () =>
      harness.driver.calls.filter((call) => call.operation === "provision").length;
    const provisionedBefore = provisions();

    const grant = await harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
      ownerId: "agent-1",
    });

    expect(grant.device.id).toBe(matching.id);
    expect(progress).toEqual([]);
    expect(provisions()).toBe(provisionedBefore);
  });

  it("provisions and makes a device ready when capacity is available, returning progress estimates", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 34 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });

    const progress: string[] = [];
    const grant = await harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-1",
      ownerId: "agent-1",
    });

    // why: `estimatedReclaimMs` is the one figure describing work still ahead of the holder --
    // what releasing this device will cost -- rather than work already done to grant it.
    expect(grant).toMatchObject({
      device: { spec: request, state: "leased" },
      timing: {
        estimatedBootMs: 20,
        estimatedProvisionMs: 10,
        estimatedReadyMs: 30,
        estimatedReclaimMs: 34,
      },
    });
    expect(driver.calls.map((call) => call.operation)).toEqual([
      "resolveSpec",
      "provision",
      "makeReady",
    ]);
  });

  it("prices the eventual reclaim even when a warm device is granted with no work at all", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 34 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    await seedReady(harness);

    const grant = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    expect(grant.timing).toEqual({
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReadyMs: 0,
      estimatedReclaimMs: 34,
    });
  });

  it("reports only the selected work as it begins, quoting a shut-down device's own prepare-boot figure", async () => {
    const clock = new FakeClock(1_000);
    // why: A real driver quotes a persisted-baseline boot below its cold figure; the fake does so only
    // for an estimate that names the device and the prepare purpose.
    class DeviceQuotingDriver extends FakeDriver {
      override estimate(estimate: DriverEstimate, spec: DeviceSpec): number {
        if (estimate.operation === "boot" && estimate.purpose === "prepare") {
          return estimate.device === undefined ? 99 : 4;
        }
        return super.estimate(estimate, spec);
      }
    }
    const driver = new DeviceQuotingDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 15 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, idleShutdownAfterMs: 0 });
    const provisioned: string[] = [];

    const provisionedGrant = await harness.engine.request(request, {
      onProgress: (progress) => provisioned.push(progress.stage),
      requesterId: "provisioned",
      ownerId: "provisioned",
    });
    expect(provisioned).toEqual(["provisioning", "booting"]);
    await harness.engine.release(provisionedGrant.lease.id, "explicit");
    await harness.engine.settle();

    // why: a released virtual device is destroyed, so the shut-down device is seeded.
    const shutdown = await seedReady(harness);
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });
    const booted: string[] = [];
    const bootEtas: (number | undefined)[] = [];
    const bootedGrant = await harness.engine.request(request, {
      onProgress: (progress) => {
        booted.push(progress.stage);
        bootEtas.push(progress.stage === "booting" ? progress.etaMs : undefined);
      },
      requesterId: "shutdown",
      ownerId: "shutdown",
    });
    expect(booted).toEqual(["booting"]);
    expect(bootEtas).toEqual([4]);
    expect(bootedGrant.timing.estimatedBootMs).toBe(4);
  });

  it("grants a shut-down device with the cold boot figure when its own boot estimate rejects", async () => {
    const clock = new FakeClock(1_000);
    class RejectingDeviceEstimateDriver extends FakeDriver {
      override estimate(estimate: DriverEstimate, spec: DeviceSpec): number {
        if (estimate.operation === "boot" && estimate.device !== undefined) {
          return Promise.reject(new Error("emulator -version failed")) as unknown as number;
        }
        return super.estimate(estimate, spec);
      }
    }
    const driver = new RejectingDeviceEstimateDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { boot: 20, provision: 10, reclaim: 15 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, idleShutdownAfterMs: 0 });
    const shutdown = await seedReady(harness);
    await harness.registry.transitionDevice(shutdown.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: shutdown.id, initiator: "test" },
    });

    const granted = harness.engine
      .request(request, { requesterId: "b", ownerId: "b" })
      .then((grant) => grant.timing.estimatedBootMs);
    // why: Without the fallback the waiter hangs, so the race turns that hang into a named failure.
    const outcome = await Promise.race([
      granted,
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 1_000)),
    ]);

    expect(outcome).toBe(20);
  });

  it("reports queue insertion without speculative work and isolates callback failures", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const harness = await createHarness({ driver });
    const holder = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const progress: string[] = [];
    const queued = harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "queued",
      ownerId: "queued",
    });
    await flush();
    expect(progress).toEqual(["queued"]);

    await expect(
      harness.engine.request(request, {
        noWait: true,
        onProgress: () => progress.push("unexpected"),
        requesterId: "no-wait",
        ownerId: "no-wait",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(progress).toEqual(["queued"]);

    await harness.engine.release(holder.lease.id, "explicit");
    await queued;

    const callbackFailure = await createHarness();
    await expect(
      callbackFailure.engine.request(request, {
        onProgress: () => {
          throw new Error("client disconnected");
        },
        requesterId: "throwing-callback",
        ownerId: "throwing-callback",
      }),
    ).resolves.toMatchObject({ device: { state: "leased" } });
    expect(callbackFailure.driver.calls.map((call) => call.operation)).toContain("makeReady");
  });

  it("cancels a queued request through the QueueControl facade and frees the requester for a later grant", async () => {
    const harness = await createHarness();
    const holder = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const queued = harness.engine.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();

    await expect(harness.engine.cancelPending("nobody")).resolves.toBe("not-found");
    await expect(harness.engine.cancelPending("queued")).resolves.toBe("cancelled");
    await expect(queued).rejects.toBeInstanceOf(RequestCancelledError);

    await harness.engine.release(holder.lease.id, "explicit");
    await expect(
      harness.engine.request(request, { ownerId: "queued", requesterId: "queued" }),
    ).resolves.toMatchObject({ lease: { ownerId: "queued", requesterId: "queued" } });
  });

  it("stamps queue.changed with the wait-queue module when a request queues and when it leaves", async () => {
    const harness = await createHarness();
    const modules: { depth: number; module: string }[] = [];
    harness.bus.subscribe("queue.changed", (envelope) =>
      modules.push({ depth: envelope.payload.depth, module: envelope.module }),
    );
    const holder = await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const queued = harness.engine.request(request, {
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();
    expect(modules).toEqual([{ depth: 1, module: "wait-queue" }]);

    await harness.engine.release(holder.lease.id, "explicit");
    await queued;
    expect(modules).toEqual([
      { depth: 1, module: "wait-queue" },
      { depth: 0, module: "wait-queue" },
    ]);
  });

  it("queues at capacity in FIFO order across three waiters", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    // why: Each waiter records its grant and hands the device straight back, so the queue drains in
    // whatever order it serves and the assertion below sees that order rather than hanging.
    const granted: string[] = [];
    const waiters = ["agent-2", "agent-3", "agent-4"].map((requesterId) =>
      harness.engine.request(request, { ownerId: requesterId, requesterId }).then(async (grant) => {
        granted.push(grant.lease.requesterId);
        await harness.engine.release(grant.lease.id, "explicit");
      }),
    );
    await flush();

    await harness.engine.release(first.lease.id, "explicit");
    await Promise.all(waiters);

    expect(granted).toEqual(["agent-2", "agent-3", "agent-4"]);
  });

  it("wakes exactly the queue head on release and grants it a new device, not the destroyed one", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const second = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    const third = harness.engine.request(request, {
      ownerId: "agent-3",
      requesterId: "agent-3",
    });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");
    const secondGrant = await second;
    await flush();

    expect(secondGrant.device.id).not.toBe(first.device.id);
    expect(harness.registry.snapshot.leases).toHaveLength(1);
    expect(harness.registry.snapshot.leases[0]?.requesterId).toBe("agent-2");
    expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    await harness.engine.release(secondGrant.lease.id, "explicit");
    await expect(third).resolves.toMatchObject({
      lease: { ownerId: "agent-3", requesterId: "agent-3" },
    });
  });

  it("provisions a new device for the queue head instead of deadlocking at capacity", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const queued = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    await harness.engine.release(first.lease.id, "explicit");

    const granted = await queued;
    expect(granted.device.id).not.toBe(first.device.id);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(2);
  });

  it("rejects a timed-out queue entry and skips it on a later release", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const progress: string[] = [];
    const timedOut = harness.engine.request(request, {
      onProgress: (update) => progress.push(update.stage),
      requesterId: "agent-2",
      ownerId: "agent-2",
      timeoutMs: 10,
    });
    const next = harness.engine.request(request, {
      ownerId: "agent-3",
      requesterId: "agent-3",
    });
    await flush();

    // why: Each outcome settles against a flush rather than an await, so a waiter left pending
    // fails the assertion that names it instead of hanging the test.
    harness.clock.advance(10);
    expect(await settledOrPending(timedOut)).toBeInstanceOf(QueueTimeoutError);
    expect(progress).toEqual(["queued"]);
    await harness.engine.release(first.lease.id, "explicit");

    expect(await settledOrPending(next)).toMatchObject({
      lease: { ownerId: "agent-3", requesterId: "agent-3" },
    });
  });

  it("expires an un-renewed lease at its deadline and serves the queue with its device", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 10 } });
    await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });
    const queued = harness.engine.request(request, {
      ownerId: "agent-2",
      requesterId: "agent-2",
    });
    await flush();

    harness.clock.advance(9);
    await flush();
    expect(await settledOrPending(queued)).toBe("still pending");

    harness.clock.advance(1);
    await flush();
    await expect(queued).resolves.toMatchObject({
      lease: { ownerId: "agent-2", requesterId: "agent-2" },
    });
  });

  it("renews via the engine, re-arming the expiry timer at the new deadline", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 10 } });
    const granted = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    harness.clock.advance(6);
    const renewed = await harness.engine.renew(granted.lease.id, 20);
    expect(renewed).toMatchObject({ lastRenewedAt: 1_006, ttlMs: 20, ttlDeadline: 1_026 });
    expect(harness.bus.replay().find((event) => event.event === "lease.renewed")?.payload).toEqual({
      leaseId: granted.lease.id,
      newDeadline: 1_026,
    });

    // why: The grant-time deadline (1_010) has now passed, but the renewal re-armed the expiry
    // timer at the new one, so the lease must still be alive.
    harness.clock.advance(4);
    await flush();
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    harness.clock.advance(16);
    await flush();
    expect(harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("grants at the request's own ttlMs, and re-applies that width on a body-less renew", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 10 } });
    const granted = await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
      ttlMs: 40,
    });
    expect(granted.lease).toMatchObject({ ttlMs: 40, ttlDeadline: 1_040 });

    harness.clock.advance(5);
    // why: No TTL named: the lease keeps its own 40ms width rather than snapping back to the
    // 10ms `lease.defaultTtlMs` (ADR 0004 §4).
    await expect(harness.engine.renew(granted.lease.id)).resolves.toMatchObject({
      ttlMs: 40,
      ttlDeadline: 1_045,
    });
  });

  it("retries after a provision failure without leaking capacity", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("provision", 1, new DriverCrashError("simulator exited"));
    const harness = await createHarness({ driver });

    // why: A request that never retried would sit pending; settling against a flush names that.
    const grant = await settledOrPending(
      harness.engine.request(request, { ownerId: "agent-1", requesterId: "agent-1" }),
    );

    expect(grant).toMatchObject({ device: { state: "leased" } });
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
      harness.engine.request(request, { ownerId: "agent-1", requesterId: "agent-1" }),
    ).rejects.toBeInstanceOf(BootTimeoutError);

    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(driver.calls.map((call) => call.operation)).toContain("destroy");
  });

  it("emits committed happy-path facts in lifecycle order", async () => {
    const harness = await createHarness();

    await harness.engine.request(request, {
      ownerId: "agent-1",
      requesterId: "agent-1",
    });

    expect(harness.bus.replay().map((event) => event.event)).toEqual([
      "lease.requested",
      "device.provisioned",
      "device.ready",
      "lease.granted",
    ]);
  });
});

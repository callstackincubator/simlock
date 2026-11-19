import { describe, expect, it } from "vitest";
import { DriverCrashError, type LeaseProgress } from "../core/index.js";
import { FakeDriver, loadTestRegistry, openTestState } from "../core/testing.js";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { request, createHarness, seedReady, flush } from "./test-create-leasing.js";
import { NoCapacityError, type LeaseEndParticipant } from "./index.js";

describe("createLeasing", () => {
  it("hands the caller back before the destroy, keeps the released device shut down, then grants the waiter a new device", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { destroy: 20 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    const release = harness.engine.release(first.lease.id, "explicit");
    const second = harness.engine.request(request, {
      ownerId: "second",
      requesterId: "second",
    });
    await flush();

    // why: the releasing caller (an agent's MCP/CLI release) is already free to move on
    // while the destroy still has its full 20ms of driver latency ahead of it.
    await expect(release).resolves.toBeUndefined();
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "shutdown" }]);
    expect(harness.engine.queueDepth).toBe(1);
    clock.advance(20);
    await harness.engine.settle();
    const granted = (await second) as { readonly device: { readonly id: string } };
    expect(granted.device.id).not.toBe(first.device.id);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(2);
  });

  it("tells a waiter queued behind a released device held in reclaiming how long a reclaim runs", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { reclaim: 34_000 },
      platform: "ios",
    });
    let endWait: () => void = () => {};
    const holding: LeaseEndParticipant = {
      leaseEnded: () =>
        new Promise<void>((resolve) => {
          endWait = resolve;
        }),
    };
    const harness = await createHarness({ driver, leaseEndParticipants: [holding] });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    await harness.engine.release(first.lease.id, "explicit");
    const progress: LeaseProgress[] = [];
    const second = harness.engine.request(request, {
      onProgress: (update) => progress.push(update),
      requesterId: "second",
      ownerId: "second",
    });
    await flush();

    // why: a queue position on its own says nothing about the wait; the device the waiter is
    // actually behind is what makes it tens of seconds rather than immediate (#56).
    expect(progress).toEqual([
      { queuePosition: 1, stage: "queued" },
      { etaMs: 34_000, stage: "reclaiming" },
    ]);
    endWait();
    await harness.engine.settle();
    const granted = (await second) as { readonly device: { readonly id: string } };
    expect(granted.device.id).not.toBe(first.device.id);
  });

  it("does not report a reclaim stage to a waiter queued behind something else", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { reclaim: 34_000 },
      platform: "ios",
    });
    const harness = await createHarness({ driver });
    await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    const progress: LeaseProgress[] = [];
    void harness.engine.request(request, {
      onProgress: (update) => progress.push(update),
      requesterId: "queued",
      ownerId: "queued",
    });
    await flush();

    // why: The only matching device is leased, not reclaiming: nothing to quote.
    expect(progress).toEqual([{ queuePosition: 1, stage: "queued" }]);
  });

  it("gives no reclaiming stage to a waiter queued while the only reclaiming device of its model and OS is physical", async () => {
    const state = await openTestState();
    const seedClock = new FakeClock(1_000);
    const seeding = await loadTestRegistry({
      clock: seedClock,
      eventBus: new EventBus(seedClock),
      idGenerator: { generate: () => "physical" },
      state,
    });
    const physical = await seeding.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "00008110-001A2B3C4D5E",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    state.database
      .prepare("UPDATE devices SET state = 'reclaiming', last_lease_ended_at = 1000 WHERE id = ?")
      .run(physical.id);
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      estimateMs: { reclaim: 34_000 },
      platform: "ios",
    });
    const harness = await createHarness({ driver, state });
    await harness.engine.request(request, { ownerId: "holder", requesterId: "holder" });
    const progress: LeaseProgress[] = [];
    void harness.engine.request(request, {
      onProgress: (update) => progress.push(update),
      ownerId: "queued",
      requesterId: "queued",
    });
    await flush();

    // why: The request is held up by the simulator limit; the physical device reclaiming beside it is
    // nobody's erase to wait for, so no reclaiming stage is quoted.
    expect(progress).toEqual([{ queuePosition: 1, stage: "queued" }]);
    expect(harness.registry.snapshot.devices.map((device) => device.id)).toContain(physical.id);
  });

  it("a release destroys the released device instead of reclaiming it, so the pool shuts no idle device down for it", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });
    const excess = await seedReady(harness);
    harness.clock.advance(5);

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    const operations = harness.driver.calls.map((call) => call.operation);
    expect(operations).toContain("destroy");
    expect(operations).not.toContain("reclaim");
    expect(
      harness.registry.snapshot.devices.find((item) => item.id === first.device.id)?.state,
    ).toBe("deleted");
    expect(harness.registry.snapshot.devices.find((item) => item.id === excess.id)?.state).toBe(
      "ready",
    );
    expect(
      harness.bus
        .replay()
        .filter(
          (event) =>
            event.event === "device.shutdown" &&
            (event.payload as { initiator?: string }).initiator === "warm-pool",
        ),
    ).toEqual([]);
  });

  it("evicts warm inventory for active new-spec demand, including no-wait", async () => {
    const harness = await createHarness({
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const warm = await seedReady(harness);
    const different = { ...request, model: "iPhone SE" };

    const grant = await harness.engine.request(different, {
      noWait: true,
      requesterId: "new-spec",
      ownerId: "new-spec",
    });

    expect(grant.device.spec.model).toBe("iPhone SE");
    expect(harness.registry.snapshot.devices.find((item) => item.id === warm.id)?.state).toBe(
      "shutdown",
    );
    expect(harness.bus.replay().find((event) => event.event === "device.shutdown")).toMatchObject({
      payload: { initiator: "warm-pool-active-demand" },
    });
  });

  it("evicts the other platform's warm device when only the global limit blocks demand", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
    const harness = await createHarness({
      driver: ios,
      drivers: [ios, android],
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const androidSpec = {
      physical: false,
      model: "Pixel 9",
      osVersion: "36",
      platform: "android",
    } as const;
    const driverDevice = await android.provision(androidSpec);
    const registered = await harness.registry.registerDevice({
      driverData: driverDevice.driverData,
      driverDeviceId: driverDevice.deviceId,
      provisionDuration: 0,
      spec: androidSpec,
    });
    await harness.registry.transitionDevice(registered.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: registered.id },
    });

    await expect(
      harness.engine.request(request, {
        ownerId: "ios-demand",
        requesterId: "ios-demand",
      }),
    ).resolves.toMatchObject({ device: { spec: { platform: "ios" } } });
    expect(harness.registry.snapshot.devices.find((item) => item.id === registered.id)?.state).toBe(
      "shutdown",
    );
    expect(android.calls.map((call) => call.operation)).toContain("shutdown");
  });

  it("does not oversubscribe when eviction fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("shutdown", 1, new DriverCrashError("cannot stop victim"));
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    await seedReady(harness);

    await expect(
      harness.engine.request(
        { ...request, model: "iPhone SE" },
        {
          noWait: true,
          requesterId: "new-spec",
          ownerId: "new-spec",
        },
      ),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(harness.engine.runningCapacity.global.running).toBe(1);
    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
  });

  it("deletes an idle managed device at maxDevices before provisioning a new spec", async () => {
    const harness = await createHarness();
    const old = await seedReady(harness);
    await harness.registry.transitionDevice(old.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: old.id, initiator: "test" },
    });

    const grant = await harness.engine.request(
      { ...request, model: "iPhone SE" },
      {
        requesterId: "new-spec",
        ownerId: "new-spec",
      },
    );

    expect(grant.device.spec.model).toBe("iPhone SE");
    expect(harness.registry.snapshot.devices.find((item) => item.id === old.id)?.state).toBe(
      "deleted",
    );
    expect(harness.driver.calls.map((call) => call.operation)).toContain("destroy");
  });

  it("quarantines a release-time destroy failure instead of keeping the device eligible", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");
    expect(
      harness.bus.replay().filter((event) => event.event === "device.purge-failed"),
    ).toMatchObject([
      {
        payload: {
          attemptedStrategy: "delete",
          deviceId: first.device.id,
          error: "DriverCrashError: purge exploded",
          leaseId: first.lease.id,
        },
      },
    ]);
    expect(
      harness.bus.replay().filter((event) => event.event === "device.quarantined"),
    ).toHaveLength(1);
    expect(harness.bus.replay().filter((event) => event.event === "device.reclaimed")).toEqual([]);
    // why: ios.maxDevices is 1 in this harness's config, and a quarantined device still
    // counts against it, so a second requester cannot provision a
    // fresh device either -- it must wait rather than silently inheriting the dirty
    // one, which is exactly the bug quarantine exists to prevent (#21).
    await expect(
      harness.engine.request(request, {
        noWait: true,
        ownerId: "second",
        requesterId: "second",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
  });

  it("never exposes a released device as ready: it is shut down, destroyed and deleted", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const harness = await createHarness({ driver });
    const first = await harness.engine.request(request, {
      ownerId: "first",
      requesterId: "first",
    });

    const readyBefore = harness.bus
      .replay()
      .filter((event) => event.event === "device.ready").length;

    await harness.engine.release(first.lease.id, "explicit");
    await harness.engine.settle();

    expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
    expect(harness.bus.replay().filter((event) => event.event === "device.ready")).toHaveLength(
      readyBefore,
    );
  });
  it("enforces global and platform limits together across drivers", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
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
      requesterId: "ios-holder",
      ownerId: "ios-holder",
    });
    const androidRequest = {
      physical: false,
      model: "Pixel 9",
      osVersion: "36",
      platform: "android",
    } as const;

    await expect(
      harness.engine.request(androidRequest, {
        noWait: true,
        requesterId: "android-no-wait",
        ownerId: "android-no-wait",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    expect(android.calls.filter((call) => call.operation === "provision")).toHaveLength(0);
    expect(android.calls.filter((call) => call.operation === "makeReady")).toHaveLength(0);

    await harness.engine.release(holder.lease.id, "explicit");
    await expect(
      harness.engine.request(androidRequest, {
        ownerId: "android",
        requesterId: "android",
      }),
    ).resolves.toMatchObject({ device: { spec: { platform: "android" } } });
  });
});

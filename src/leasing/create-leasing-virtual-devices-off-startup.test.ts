import { describe, expect, it } from "vitest";
import { toDriverDevice } from "../core/index.js";
import { FakeDriver, openTestState } from "../core/testing.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { androidRequest, createHarness, flush, request, seedReady } from "./test-create-leasing.js";

// why: a model no lease below asks for, so the leases make their own devices and leave these idle.
const ANDROID = {
  model: "Pixel 7",
  osVersion: "36",
  physical: false,
  platform: "android",
} as const;
const IOS = { ...request, physical: false } as const;
const LIMITS = {
  android: { maxDevices: 8, maxRunning: 8 },
  ios: { maxDevices: 8, maxRunning: 8 },
  maxRunning: 16,
};

type Failure = "destroy" | "shutdown" | undefined;

/** why: the worker ran with virtual devices on, left devices behind in every state, and starts again with Android phones-only. */
async function restartedPhonesOnly(failure: Failure = undefined) {
  const clock = new FakeClock(1_000);
  const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const android = new FakeDriver({ availableOsVersions: ["36"], clock, platform: "android" });
  const state = await openTestState();
  const before = await createHarness({
    drivers: [ios, android],
    lease: { defaultTtlMs: 900_000 },
    limits: LIMITS,
    state,
  });
  const phone = await before.registry.enrollPhysical({
    apps: [],
    class: "phone",
    driverDeviceId: "serial-1",
    model: "Pixel 8",
    osVersion: "35",
    platform: "android",
  });
  const saver = await before.engine.request(androidRequest, {
    ownerId: "saver",
    requesterId: "saver",
  });
  await before.engine.core.baselines.save({
    leaseId: saver.lease.id,
    name: "checkout",
    requesterId: "saver",
  });
  const leased = await before.engine.request(androidRequest, {
    ownerId: "holder",
    requesterId: "holder",
  });
  before.engine.dispose();

  const sink = new MemoryLogSink();
  const after = await createHarness({
    drivers: [ios, android],
    firstId: 5_000,
    lease: { defaultTtlMs: 900_000 },
    limits: LIMITS,
    logger: new JsonLinesLogger({ clock, sink }),
    state,
    virtualDevices: { android: false },
  });

  const ready = await seedReady(after, ANDROID, "full", android);
  const claimed = await seedReady(after, ANDROID, "full", android);
  const shutdown = await seedReady(after, ANDROID, "full", android);
  await android.shutdown(toDriverDevice(shutdown));
  await after.registry.transitionDevice(shutdown.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: shutdown.id, initiator: "test" },
  });
  const iosIdle = await seedReady(after, IOS, "full", ios);
  after.engine.core.claims.tryClaim(claimed.id, "boot");
  const next = (operation: "destroy" | "shutdown") =>
    android.calls.filter((call) => call.operation === operation).length + 1;
  if (failure !== undefined) {
    android.failOn(failure, next(failure), new Error(`${failure} refused`));
  }
  const mark = after.bus.replay().length;
  await after.engine.convergeRunningCapacity();
  await flush();
  const events = after.bus
    .replay()
    .slice(mark)
    .filter((event) => event.event === "device.shutdown" || event.event === "device.deleted")
    .map((event) => ({ ...(event.payload as object), event: event.event }));
  const stateOf = (id: string) =>
    after.registry.snapshot.devices.find((device) => device.id === id)?.state;
  return {
    after,
    claimed,
    events,
    iosIdle,
    leased,
    logs: sink.records,
    phone,
    ready,
    shutdown,
    stateOf,
  };
}

describe("startup on a worker whose android.virtualDevices is false", () => {
  it("deletes the platform's idle devices, keeps leased, claimed, phone and iOS devices and the baseline, and goes on when a delete fails", async () => {
    const world = await restartedPhonesOnly();

    expect(world.events).toEqual([
      { deviceId: world.ready.id, event: "device.shutdown", initiator: "virtual-devices-off" },
      {
        deviceId: world.ready.id,
        event: "device.deleted",
        initiator: "virtual-devices-off",
        physical: false,
      },
      {
        deviceId: world.shutdown.id,
        event: "device.deleted",
        initiator: "virtual-devices-off",
        physical: false,
      },
    ]);
    expect(world.stateOf(world.ready.id)).toBe("deleted");
    expect(world.stateOf(world.shutdown.id)).toBe("deleted");
    expect(world.stateOf(world.claimed.id)).toBe("ready");
    expect(world.stateOf(world.phone.id)).toBe("ready");
    expect(world.stateOf(world.iosIdle.id)).toBe("ready");
    expect(world.stateOf(world.leased.device.id)).toBe("leased");
    expect((await world.after.engine.core.baselines.list()).map((entry) => entry.name)).toEqual([
      "checkout",
    ]);

    await world.after.engine.release(world.leased.lease.id, "explicit");
    await flush();
    expect(world.stateOf(world.leased.device.id)).toBe("deleted");
    expect(
      world.after.bus
        .replay()
        .filter(
          (event) =>
            event.event === "device.deleted" &&
            (event.payload as { deviceId: string }).deviceId === world.leased.device.id,
        )
        .map((event) => (event.payload as { initiator: string }).initiator),
    ).toEqual(["lease-end"]);

    const destroyFails = await restartedPhonesOnly("destroy");
    expect(destroyFails.stateOf(destroyFails.ready.id)).toBe("shutdown");
    expect(destroyFails.stateOf(destroyFails.shutdown.id)).toBe("deleted");
    expect(destroyFails.logs).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ deviceId: destroyFails.ready.id, platform: "android" }),
        level: "warn",
        message: "Could not delete an idle device at start",
      }),
    );

    const shutdownFails = await restartedPhonesOnly("shutdown");
    expect(shutdownFails.stateOf(shutdownFails.ready.id)).toBe("ready");
    expect(shutdownFails.stateOf(shutdownFails.shutdown.id)).toBe("deleted");
    expect(shutdownFails.logs).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ deviceId: shutdownFails.ready.id, platform: "android" }),
        level: "warn",
        message: "Could not delete an idle device at start",
      }),
    );
  });
});

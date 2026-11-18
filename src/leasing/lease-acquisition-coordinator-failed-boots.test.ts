import { describe, expect, it, vi } from "vitest";
import { FakeClock, JsonLinesLogger, type Logger, MemoryLogSink } from "../ports/index.js";
import { capacityDevice, capacityDevices, DriverCrashError } from "../core/index.js";
import {
  request,
  createHarness,
  seedReady,
  settle,
  seedShutdown,
} from "./test-lease-acquisition.js";

function capturingLogger(): { readonly logger: Logger; readonly sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }), sink };
}

describe("LeaseAcquisitionCoordinator", () => {
  it("A failed eviction shutdown logs the device id and the error, and the waiter is deferred as before.", async () => {
    const { logger, sink } = capturingLogger();
    // Two devices allowed but only one running: a running device of another spec is
    // evicted by shutdown (not deleted) to make room for the request.
    const harness = await createHarness({ logger, maxDevices: 2 });
    const victim = await seedReady(harness, { ...request, model: "iPhone SE" });
    harness.driver.failOn("shutdown", 1, new DriverCrashError("shutdown wedged"));

    let settled = false;
    const acquisition = harness.coordinator.request(request, {
      ownerId: "evictor",
      requesterId: "evictor",
    });
    void acquisition.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        module: "daemon.lease-acquisition-coordinator",
        fields: {
          deviceId: victim.id,
          error: "DriverCrashError: shutdown wedged",
          requesterId: "evictor",
          step: "shutdown",
        },
      }),
    ]);
    // Deferred: back in the queue, still pending, and the victim untouched.
    expect(settled).toBe(false);
    expect(harness.coordinator.queueDepth).toBe(1);
    expect(harness.registry.snapshot.devices.find((device) => device.id === victim.id)?.state).toBe(
      "ready",
    );
    await harness.coordinator.cancelPending("evictor");
    await expect(acquisition).rejects.toMatchObject({ name: "RequestCancelledError" });
  });

  it("A failed eviction delete logs the device id and the error.", async () => {
    const { logger, sink } = capturingLogger();
    // One device allowed: a managed device of another spec is deleted to make room.
    const harness = await createHarness({ logger, maxDevices: 1 });
    const victim = await seedShutdown(harness, { ...request, model: "iPhone SE" });
    harness.driver.failOn("destroy", 1, new DriverCrashError("simctl delete refused"));

    const acquisition = harness.coordinator.request(request, {
      ownerId: "evictor",
      requesterId: "evictor",
    });
    await settle();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: victim.id,
          error: "DriverCrashError: simctl delete refused",
          requesterId: "evictor",
          step: "delete",
        },
      }),
    ]);
    await harness.coordinator.cancelPending("evictor");
    await expect(acquisition).rejects.toMatchObject({ name: "RequestCancelledError" });
  });

  it("A failed destroy after a shut-down device fails to boot for a waiter logs the device id and the error.", async () => {
    const { logger, sink } = capturingLogger();
    const harness = await createHarness({ logger });
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simulator would not die"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({
      name: "BootTimeoutError",
      message: expect.stringContaining("simulator never booted"),
    });

    expect(sink.records.filter((record) => record.fields?.["step"] === "destroy")).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId: shutdown.id,
          error: "DriverCrashError: simulator would not die",
          requesterId: "booter",
          step: "destroy",
        },
      }),
    ]);
  });

  it("A shut-down device that fails to boot for a waiter and then fails to be destroyed is quarantined and counts once against running capacity.", async () => {
    // why: two running slots — the failed device's and the one a second request needs.
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const shutdown = await seedShutdown(harness);
    // why: call 1 is seedShutdown's own boot; call 2 is the waiter's.
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simulator would not die"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });
    await settle();

    expect(
      harness.registry.snapshot.devices.find((device) => device.id === shutdown.id)?.state,
    ).toBe("quarantined");
    // why: `quarantined` already counts as running — a reservation still held would count
    // this device twice and refuse the second slot.
    await expect(
      harness.coordinator.request(
        { ...request, model: "iPhone SE" },
        { noWait: true, ownerId: "second", requesterId: "second" },
      ),
    ).resolves.toMatchObject({ device: { spec: { model: "iPhone SE" }, state: "leased" } });
  });

  it("grants a request that arrives while a failed boot's device is being destroyed a device of its own, without waiting for the destroy.", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const shutdownId = (await seedShutdown(harness)).id;
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    let failDestroy: (error: Error) => void = () => undefined;
    const realDestroy = harness.driver.destroy.bind(harness.driver);
    let destroys = 0;
    vi.spyOn(harness.driver, "destroy").mockImplementation(async (device) => {
      destroys += 1;
      if (destroys > 1) return realDestroy(device);
      return new Promise<void>((_resolve, reject) => {
        failDestroy = reject;
      });
    });

    const booter = harness.coordinator.request(request, {
      ownerId: "booter",
      requesterId: "booter",
    });
    const booterOutcome = booter.catch((error: unknown) => error);
    await settle();
    const second = harness.coordinator.request(request, { ownerId: "b", requesterId: "b" });
    let secondGranted = false;
    void second.then(() => {
      secondGranted = true;
    });
    await settle();

    expect(secondGranted).toBe(true);
    expect((await second).device.id).not.toBe(shutdownId);

    failDestroy(new DriverCrashError("simulator would not die"));
    await booterOutcome;
  });

  it("A device whose boot for a waiter failed is deleted by the lease engine, and its slot is freed.", async () => {
    const harness = await createHarness();
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    expect(harness.bus.replay().filter((event) => event.event === "device.deleted")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ deviceId: shutdown.id, initiator: "lease-engine" }),
      }),
    ]);
    await expect(
      harness.coordinator.request(request, {
        noWait: true,
        ownerId: "second",
        requesterId: "second",
      }),
    ).resolves.toMatchObject({ lease: { requesterId: "second" } });
  });

  it("A failed boot whose device the destroy can no longer claim frees the waiter's running slot and leaves no fence.", async () => {
    const harness = await createHarness();
    const shutdown = await seedShutdown(harness);
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));
    const realMakeReady = harness.driver.makeReady.bind(harness.driver);
    let failedBoots = 0;
    vi.spyOn(harness.driver, "makeReady").mockImplementation(async (...args) => {
      try {
        return await realMakeReady(...args);
      } finally {
        failedBoots += 1;
        // The record leaves `shutdown` while the boot fails, so the destroy finds nothing to claim.
        if (failedBoots === 1) {
          await harness.registry.transitionDevice(shutdown.id, "deleted", {
            event: "device.deleted",
            payload: { deviceId: shutdown.id, initiator: "test" },
          });
        }
      }
    });

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });

    await expect(
      harness.coordinator.request(request, {
        noWait: true,
        ownerId: "second",
        requesterId: "second",
      }),
    ).resolves.toMatchObject({ lease: { requesterId: "second" } });
  });

  it.each([
    ["answers that another operation owns the device", async (): Promise<boolean> => false],
    ["throws", async (): Promise<boolean> => Promise.reject(new Error("state write failed"))],
  ] as const)(
    "A failed boot whose destroy throws frees the waiter's running slot and leaves no fence, even when quarantine %s.",
    async (_label, enterFromStalledTransition) => {
      const harness = await createHarness({
        lifecycle: (lifecycle) => ({
          bootForLease: (device, claim) => lifecycle.bootForLease(device, claim),
          rebootForLease: (...args) => lifecycle.rebootForLease(...args),
          dispose: (...args) => lifecycle.dispose(...args),
          shutdown: (...args) => lifecycle.shutdown(...args),
          destroy: () => Promise.reject(new DriverCrashError("simulator would not delete")),
        }),
        quarantine: { enterFromStalledTransition },
      });
      const shutdown = await seedShutdown(harness);
      harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

      await expect(
        harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
      ).rejects.toMatchObject({ name: "BootTimeoutError" });
      await settle();

      await expect(
        harness.coordinator.request(request, { ownerId: "second", requesterId: "second" }),
      ).resolves.toMatchObject({ device: { id: shutdown.id, state: "leased" } });
    },
  );

  it("releases the running slot reserved to boot a shut-down device for a waiter when the boot fails and another boot claims the device before it is destroyed", async () => {
    // The warm pool's boot reserves its own slot and claims the device in one decision. Here it
    // lands after the failed boot has released its claim and before the destroy claims the device.
    let raced = false;
    let warmBoot: { release(): void } | undefined;
    const harness = await createHarness({
      maxDevices: 2,
      maxRunning: 2,
      lifecycle: (lifecycle, { capacity, claims, registry }) => ({
        bootForLease: (device, claim) => lifecycle.bootForLease(device, claim),
        rebootForLease: (...args) => lifecycle.rebootForLease(...args),
        dispose: (...args) => lifecycle.dispose(...args),
        shutdown: (...args) => lifecycle.shutdown(...args),
        destroy: (device, initiator, operation, claim) => {
          const reservation = capacity.tryReserveBoot(
            capacityDevice(device),
            capacityDevices(registry.snapshot.virtualDevices),
          );
          const warmClaim = claims.tryClaim(device.id, "boot");
          raced = reservation.ok && warmClaim !== undefined;
          warmBoot = {
            release: () => {
              warmClaim?.release();
              if (reservation.ok) reservation.reservation.release();
            },
          };
          return lifecycle.destroy(device, initiator, operation, claim);
        },
      }),
    });
    await seedShutdown(harness);
    // Call 1 is seedShutdown's own boot; call 2 is the waiter's.
    harness.driver.failOn("makeReady", 2, new DriverCrashError("simulator never booted"));

    await expect(
      harness.coordinator.request(request, { ownerId: "booter", requesterId: "booter" }),
    ).rejects.toMatchObject({ name: "BootTimeoutError" });
    expect(raced).toBe(true);

    // The warm pool's boot ends and gives back its own claim and slot.
    warmBoot?.release();
    await settle();

    for (const requester of ["first", "second"]) {
      await expect(
        harness.coordinator.request(request, {
          noWait: true,
          ownerId: requester,
          requesterId: requester,
        }),
      ).resolves.toMatchObject({ lease: { requesterId: requester } });
    }
  });
});

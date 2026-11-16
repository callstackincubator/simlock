import { describe, expect, it } from "vitest";
import { type DriverDevice } from "../core/index.js";
import { testStateOf } from "../core/testing.js";
import {
  FakeDriver,
  loadTestRegistry,
  openTestState,
  testComponentWiring,
} from "../core/testing.js";
import { EventBus } from "../bus/index.js";
import { FakeClock, FakeSystemStats } from "../ports/index.js";
import { createTestEngine } from "./testing.js";
import { gibibyte, request, config, createHarness, flush } from "./test-create-leasing.js";

// why: #43: startup convergence used to await each orphaned held lease's device reclaim
// inline (an erase measured ~34s for one simulator), so N orphaned leases cost N
// serial erases before any other request could be served. These cover the shape
// that replaced it: the lease is released registry-only on the convergence path,
// and its reclaim proceeds in the background.
import { NoCapacityError } from "./index.js";

describe("createLeasing startup reclaim backgrounding (#43)", () => {
  it("converges without waiting for an in-flight destroy, and a fresh request is served immediately after", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      // why: Matches the issue's measured single-simulator-erase cost -- the old inline
      // await would have forced convergence to sit through this.
      latencyMs: { destroy: 34_000 },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 2,
      },
    });
    // why: under ADR 0004 convergence itself releases nothing -- there is no orphan sweep left --
    // so the in-flight destroy it must not block on is produced the way one actually arises:
    // a release commits the registry half and hands the 34s destroy off to the background.
    const released = await harness.engine.request(request, {
      ownerId: "previous-holder",
      requesterId: "previous-holder",
    });
    await harness.engine.release(released.lease.id, "explicit");

    const convergeStartedAt = harness.clock.now();
    await harness.engine.convergeRunningCapacity();
    // why: the clock never had to move for convergence to finish: it did not sit through
    // the 34s destroy above.
    expect(harness.clock.now()).toBe(convergeStartedAt);
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === released.device.id)?.state,
    ).toBe("shutdown");
    expect(harness.registry.snapshot.leases).toEqual([]);

    // why: a fresh request is servable right away -- capacity allows a second device, and the
    // one still mid-destroy never blocks it. Still 0ms elapsed.
    const granted = await harness.engine.request(request, {
      requesterId: "new-agent",
      ownerId: "new-agent",
    });
    expect(granted.device.id).not.toBe(released.device.id);
    expect(harness.clock.now()).toBe(convergeStartedAt);
  });

  it("never grants a device whose background destroy is still in flight", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { destroy: 34_000 },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 1,
      },
    });
    const released = await harness.engine.request(request, {
      ownerId: "previous-holder",
      requesterId: "previous-holder",
    });
    await harness.engine.release(released.lease.id, "explicit");

    await harness.engine.convergeRunningCapacity();
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "shutdown" }]);

    // why: a device that ended a lease is never granted again, even to reboot it. With maxDevices:1
    // there is also no room to provision a second device, so the request is refused rather than
    // handed the one still mid-destroy.
    await expect(
      harness.engine.request(request, {
        noWait: true,
        ownerId: "new-agent",
        requesterId: "new-agent",
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    clock.advance(34_000);
    await flush();
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);

    // why: once the destroy finishes the slot is free again, and a new device is provisioned for it.
    const granted = await harness.engine.request(request, {
      ownerId: "new-agent",
      requesterId: "new-agent",
    });
    expect(granted.device.id).not.toBe(released.device.id);
  });

  it("recovers a background destroy interrupted by a daemon crash on the next start", async () => {
    const state = await openTestState();
    let nextId = 1;
    const idGenerator = { generate: () => `${nextId++}` };
    const systemStats = () =>
      new FakeSystemStats({
        cpuCount: 8,
        totalRamBytes: 32 * gibibyte,
      });
    // why: the physical device survives a daemon restart even though the daemon's
    // in-memory state does not -- represented here by one FakeDriver instance
    // shared across both simulated processes below.
    // why: the first destroy never returns, as one in a crashed daemon never does.
    class CrashingDestroyDriver extends FakeDriver {
      #destroys = 0;
      override async destroy(device: DriverDevice): Promise<void> {
        this.#destroys += 1;
        if (this.#destroys === 1) return new Promise<void>(() => {});
        return super.destroy(device);
      }
    }
    const driver = new CrashingDestroyDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
    });

    const clock1 = new FakeClock(1_000);
    const bus1 = new EventBus(clock1);
    const registry1 = await loadTestRegistry({
      clock: clock1,
      eventBus: bus1,
      idGenerator,
      state,
    });
    const engine1 = createTestEngine({
      ...testComponentWiring({
        clock: clock1,
        drivers: [driver],
        eventBus: bus1,
        registry: registry1,
      }),
      clock: clock1,
      config: config(),
      drivers: [driver],
      eventBus: bus1,
      idGenerator,
      registry: registry1,
      state: testStateOf(registry1),
      systemStats: systemStats(),
    });
    const granted = await engine1.request(request, {
      ownerId: "previous-holder",
      requesterId: "previous-holder",
    });
    // why: the holder released, so the destroy behind it is running in the background...
    await engine1.release(granted.lease.id, "explicit");

    // why: ...convergence leaves it alone (it is claimed by this process)...
    await engine1.convergeRunningCapacity();
    expect(registry1.snapshot.devices).toMatchObject([
      { id: granted.device.id, state: "shutdown" },
    ]);
    // why: ...and the process is abandoned before the driver's 34s destroy resolves --
    // exactly like a crashed daemon. Nothing here ever settles that promise.

    // why: next start: a fresh process reads the same persisted registry (state.db
    // survives the crash) and reconnects to the same physical driver, but its
    // in-memory claim tracking starts empty -- there is no live claim for this
    // device, because the process that held it is gone.
    const clock2 = new FakeClock(clock1.now());
    const bus2 = new EventBus(clock2);
    const registry2 = await loadTestRegistry({
      clock: clock2,
      eventBus: bus2,
      idGenerator,
      state,
    });
    const engine2 = createTestEngine({
      ...testComponentWiring({
        clock: clock2,
        drivers: [driver],
        eventBus: bus2,
        registry: registry2,
      }),
      clock: clock2,
      config: config(),
      drivers: [driver],
      eventBus: bus2,
      idGenerator,
      registry: registry2,
      state: testStateOf(registry2),
      systemStats: systemStats(),
    });

    await engine2.convergeRunningCapacity();
    await flush();

    // why: recovered by destroying the spent device again, never by reclaiming it.
    expect(registry2.snapshot.devices).toMatchObject([{ id: granted.device.id, state: "deleted" }]);
    expect(driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(0);
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
  });

  it("leaves no armed timer behind for a lease it is disposed with", async () => {
    const harness = await createHarness({ lease: { defaultTtlMs: 900_000 } });
    await harness.engine.request(request, {
      ownerId: "holder",
      requesterId: "holder",
    });
    expect(harness.clock.pendingTimerCount).toBeGreaterThan(0);

    harness.engine.dispose();

    // why: A real `setTimeout` holds the event loop open, so a timer surviving disposal is a
    // daemon that has decided to stop and cannot: `daemon stop` used to hang for the whole
    // of an outstanding lease's TTL. Under ADR 0004 that is every lease, since a stop
    // releases none of them.
    expect(harness.clock.pendingTimerCount).toBe(0);
    // why: The lease itself is untouched -- disposal cancels a timer, it does not expire a
    // lease, which is what lets a lease survive the restart with its deadline intact.
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });
});

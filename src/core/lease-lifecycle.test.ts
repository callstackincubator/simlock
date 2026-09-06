import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem, type Filesystem } from "../ports/index.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { Registry } from "./registry.js";

const statePath = "/home/agent/.simlock/state.json";

async function createHarness(options: { readonly filesystem?: Filesystem } = {}) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: options.filesystem ?? new MemoryFilesystem(),
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const device = await registry.registerDevice({
    driverData: {},
    driverDeviceId: "driver_1",
    provisionDuration: 0,
    spec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
  });
  await registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });

  let lifecycle!: LeaseLifecycle;
  const expiryScheduler = new LeaseExpiryScheduler(clock, async (leaseId) => {
    await lifecycle.beginRelease(leaseId, "expired");
  });
  lifecycle = new LeaseLifecycle({
    clock,
    eventBus,
    expiryScheduler,
    registry,
    ttl: { defaultMs: 20 },
  });
  return { clock, device, eventBus, expiryScheduler, lifecycle, registry };
}

describe("LeaseLifecycle", () => {
  it("grants a lease at lease.defaultTtlMs, storing that width and lastRenewedAt", async () => {
    const harness = await createHarness();
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      requesterId: "agent",
      ownerId: "agent",
    });
    expect(grant.lease).toMatchObject({ lastRenewedAt: 1_000, ttlMs: 20, ttlDeadline: 1_020 });
    expect(harness.registry.snapshot.devices).toMatchObject([
      { id: harness.device.id, state: "leased" },
    ]);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "lease.granted",
        payload: expect.objectContaining({ leaseId: grant.lease.id }),
      }),
    );
  });

  it("grants a lease at the width the request asked for, and stores that instead", async () => {
    const harness = await createHarness();
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 50,
    });
    expect(grant.lease).toMatchObject({ ttlMs: 50, ttlDeadline: 1_050 });
  });

  it("renews with an explicit ttlMs, re-arming the timer and storing the new width", async () => {
    const harness = await createHarness();
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      requesterId: "agent",
      ownerId: "agent",
    });
    expect(grant.lease.ttlDeadline).toBe(1_020);

    // Renew just before the grant-time deadline would have fired.
    harness.clock.advance(8);
    const renewed = await harness.lifecycle.renew(grant.lease.id, 30);
    expect(renewed).toMatchObject({ lastRenewedAt: 1_008, ttlMs: 30, ttlDeadline: 1_038 });
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "lease.renewed",
        payload: { leaseId: grant.lease.id, newDeadline: 1_038 },
      }),
    );

    // The grant-time deadline has now passed, but the timer was re-armed at the new one.
    harness.clock.advance(12);
    await Promise.resolve();
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    // The new deadline still fires.
    harness.clock.advance(18);
    await vi.waitFor(() => expect(harness.registry.snapshot.leases).toEqual([]));
  });

  it("renews with no ttlMs by re-applying the lease's own width, never lease.defaultTtlMs", async () => {
    const harness = await createHarness();
    // Granted wider than the 20ms default, exactly the case ADR 0004 §4 exists for: a lease
    // asked for a long TTL and must not shrink to the default the first time it is renewed.
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60,
    });

    harness.clock.advance(5);
    const renewed = await harness.lifecycle.renew(grant.lease.id);
    expect(renewed).toMatchObject({ ttlMs: 60, ttlDeadline: 1_065 });
  });

  it("keeps re-applying a width a previous renew set, not the grant-time one", async () => {
    const harness = await createHarness();
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      requesterId: "agent",
      ownerId: "agent",
      ttlMs: 60,
    });

    harness.clock.advance(5);
    await harness.lifecycle.renew(grant.lease.id, 40);
    harness.clock.advance(5);
    const renewed = await harness.lifecycle.renew(grant.lease.id);
    expect(renewed).toMatchObject({ ttlMs: 40, ttlDeadline: 1_050 });
  });

  it("emits release and expiry facts only after a registry release commit", async () => {
    const released = await createHarness();
    const grant = await released.lifecycle.grant({
      deviceId: released.device.id,
      requesterId: "agent",
      ownerId: "agent",
    });
    let releasedLeaseCountAtEvent = -1;
    released.eventBus.subscribe("lease.released", () => {
      releasedLeaseCountAtEvent = released.registry.snapshot.leases.length;
    });
    await released.lifecycle.beginRelease(grant.lease.id, "explicit");
    expect(released.registry.snapshot.leases).toEqual([]);
    expect(releasedLeaseCountAtEvent).toBe(0);
    expect(released.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "lease.released",
        payload: expect.objectContaining({ reason: "explicit" }),
      }),
    );

    const expired = await createHarness();
    await expired.lifecycle.grant({
      deviceId: expired.device.id,
      requesterId: "agent",
      ownerId: "agent",
    });
    let expiredLeaseCountAtEvent = -1;
    expired.eventBus.subscribe("lease.expired", () => {
      expiredLeaseCountAtEvent = expired.registry.snapshot.leases.length;
    });
    expired.clock.advance(20);
    await vi.waitFor(() => expect(expired.registry.snapshot.leases).toEqual([]));
    expect(expiredLeaseCountAtEvent).toBe(0);
    expect(expired.eventBus.replay()).toContainEqual(
      expect.objectContaining({ event: "lease.expired" }),
    );
  });

  it("restores the renewed deadline (not the grant-time one) after a restart", async () => {
    const filesystem = new MemoryFilesystem();
    const before = await createHarness({ filesystem });
    const grant = await before.lifecycle.grant({
      deviceId: before.device.id,
      requesterId: "agent",
      ownerId: "agent",
    });
    expect(grant.lease.ttlDeadline).toBe(1_020);

    before.clock.advance(5);
    const renewed = await before.lifecycle.renew(grant.lease.id, 30);
    expect(renewed.ttlDeadline).toBe(1_035);

    // Simulate a daemon restart: a fresh clock/event bus/scheduler/lifecycle reload the
    // same persisted registry state and restore timers from it.
    const afterClock = new FakeClock(1_005);
    const afterEventBus = new EventBus(afterClock);
    const afterRegistry = await Registry.load({
      clock: afterClock,
      eventBus: afterEventBus,
      filesystem,
      idGenerator: { generate: () => "unused" },
      statePath,
    });
    let afterLifecycle!: LeaseLifecycle;
    const afterScheduler = new LeaseExpiryScheduler(afterClock, async (leaseId) => {
      await afterLifecycle.beginRelease(leaseId, "expired");
    });
    afterLifecycle = new LeaseLifecycle({
      clock: afterClock,
      eventBus: afterEventBus,
      expiryScheduler: afterScheduler,
      registry: afterRegistry,
      ttl: { defaultMs: 20 },
    });
    await afterLifecycle.restoreExpiryTimers();

    // Advance to (and past) the original grant-time deadline: a restart that restored the
    // stale grant-time deadline instead of the renewed one would have expired the lease here.
    afterClock.advance(20);
    await Promise.resolve();
    expect(afterRegistry.snapshot.leases).toHaveLength(1);

    // The renewed deadline still fires.
    afterClock.advance(15);
    await vi.waitFor(() => expect(afterRegistry.snapshot.leases).toEqual([]));
  });
});

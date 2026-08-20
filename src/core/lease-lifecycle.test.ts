import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem, type Filesystem } from "../ports/index.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { DetachedLeaseHeartbeatError, LeaseLifecycle } from "./lease-lifecycle.js";
import { Registry } from "./registry.js";

const statePath = "/home/agent/.pitlane/state.json";

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
    ttl: { detachedMs: 20, heldBackstopMs: 10 },
  });
  return { clock, device, eventBus, expiryScheduler, lifecycle, registry };
}

describe("LeaseLifecycle", () => {
  it("grants held and detached leases with their respective TTLs after committing", async () => {
    const held = await createHarness();
    const heldGrant = await held.lifecycle.grant({
      deviceId: held.device.id,
      mode: "held",
      requesterId: "held-agent",
    });
    expect(heldGrant.lease.ttlDeadline).toBe(1_010);
    expect(held.registry.snapshot.devices).toMatchObject([{ id: held.device.id, state: "leased" }]);
    expect(held.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "lease.granted",
        payload: expect.objectContaining({ leaseId: heldGrant.lease.id }),
      }),
    );

    const detached = await createHarness();
    const detachedGrant = await detached.lifecycle.grant({
      deviceId: detached.device.id,
      mode: "detached",
      requesterId: "detached-agent",
    });
    expect(detachedGrant.lease.ttlDeadline).toBe(1_020);
  });

  it("renews detached leases and replaces their timer", async () => {
    const harness = await createHarness();
    const detached = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      mode: "detached",
      requesterId: "agent",
    });
    const renewed = await harness.lifecycle.renew(detached.lease.id, 30);
    expect(renewed.ttlDeadline).toBe(1_030);
    harness.clock.advance(20);
    await Promise.resolve();
    expect(harness.registry.snapshot.leases).toHaveLength(1);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "lease.renewed",
        payload: { leaseId: detached.lease.id, newDeadline: 1_030 },
      }),
    );
  });

  it("renews a held lease, extending its deadline and re-arming the expiry timer", async () => {
    const held = await createHarness();
    const grant = await held.lifecycle.grant({
      deviceId: held.device.id,
      mode: "held",
      requesterId: "agent",
    });
    expect(grant.lease.ttlDeadline).toBe(1_010);

    // Renew with an explicit TTL just before the original (grant-time) deadline would fire.
    held.clock.advance(8);
    const renewed = await held.lifecycle.renew(grant.lease.id, 30);
    expect(renewed.ttlDeadline).toBe(1_038);
    expect(held.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "lease.renewed",
        payload: { leaseId: grant.lease.id, newDeadline: 1_038 },
      }),
    );

    // The original deadline has now passed, but the timer was re-armed at the new
    // deadline, so the lease must not have expired.
    held.clock.advance(2);
    await Promise.resolve();
    expect(held.registry.snapshot.leases).toHaveLength(1);

    // The new deadline still fires.
    held.clock.advance(28);
    await vi.waitFor(() => expect(held.registry.snapshot.leases).toEqual([]));
  });

  it("renews a held lease with no explicit ttlMs using the held backstop, not the detached TTL", async () => {
    const harness = await createHarness();
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      mode: "held",
      requesterId: "agent",
    });
    expect(grant.lease.ttlDeadline).toBe(1_010);

    harness.clock.advance(5);
    const renewed = await harness.lifecycle.renew(grant.lease.id);
    // heldBackstopMs is 10 in this harness, detachedMs is 20 -- a deadline of 1_025 would
    // mean the (wrong) detached default was used instead of the held backstop.
    expect(renewed.ttlDeadline).toBe(1_015);
  });

  it("emits release and expiry facts only after a registry release commit", async () => {
    const released = await createHarness();
    const grant = await released.lifecycle.grant({
      deviceId: released.device.id,
      mode: "held",
      requesterId: "agent",
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
      mode: "held",
      requesterId: "agent",
    });
    let expiredLeaseCountAtEvent = -1;
    expired.eventBus.subscribe("lease.expired", () => {
      expiredLeaseCountAtEvent = expired.registry.snapshot.leases.length;
    });
    expired.clock.advance(10);
    await vi.waitFor(() => expect(expired.registry.snapshot.leases).toEqual([]));
    expect(expiredLeaseCountAtEvent).toBe(0);
    expect(expired.eventBus.replay()).toContainEqual(
      expect.objectContaining({ event: "lease.expired" }),
    );
  });

  it("slides a held lease's deadline on heartbeat, emits lease.renewed, and replaces its timer", async () => {
    const harness = await createHarness();
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      mode: "held",
      requesterId: "agent",
    });
    expect(grant.lease.ttlDeadline).toBe(1_010);

    harness.clock.advance(6);
    const renewed = await harness.lifecycle.heartbeat(grant.lease.id);
    expect(renewed.ttlDeadline).toBe(1_016);
    expect(harness.registry.snapshot.leases).toEqual([
      expect.objectContaining({ id: grant.lease.id, ttlDeadline: 1_016 }),
    ]);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "lease.renewed",
        payload: { leaseId: grant.lease.id, newDeadline: 1_016 },
      }),
    );

    // The original (un-slid) deadline has now passed, but the timer was replaced, so the
    // lease must not have expired.
    harness.clock.advance(4);
    await Promise.resolve();
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    // The slid deadline, however, still fires.
    harness.clock.advance(6);
    await vi.waitFor(() => expect(harness.registry.snapshot.leases).toEqual([]));
  });

  it("refuses to heartbeat a detached lease, whose TTL is not the held backstop", async () => {
    const harness = await createHarness();
    const grant = await harness.lifecycle.grant({
      deviceId: harness.device.id,
      mode: "detached",
      requesterId: "agent",
    });

    await expect(harness.lifecycle.heartbeat(grant.lease.id)).rejects.toBeInstanceOf(
      DetachedLeaseHeartbeatError,
    );
    expect(harness.registry.snapshot.leases).toEqual([
      expect.objectContaining({ id: grant.lease.id, ttlDeadline: grant.lease.ttlDeadline }),
    ]);
  });

  it("restores the heartbeat-slid deadline (not the grant-time one) after a restart", async () => {
    const filesystem = new MemoryFilesystem();
    const before = await createHarness({ filesystem });
    const grant = await before.lifecycle.grant({
      deviceId: before.device.id,
      mode: "held",
      requesterId: "agent",
    });
    expect(grant.lease.ttlDeadline).toBe(1_010);

    before.clock.advance(5);
    const renewed = await before.lifecycle.heartbeat(grant.lease.id);
    expect(renewed.ttlDeadline).toBe(1_015);

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
      ttl: { detachedMs: 20, heldBackstopMs: 10 },
    });
    await afterLifecycle.restoreExpiryTimers();

    // Advance to (and past) the original grant-time deadline: a restart that restored the
    // stale grant-time deadline instead of the slid one would have expired the lease here.
    afterClock.advance(5);
    await Promise.resolve();
    expect(afterRegistry.snapshot.leases).toHaveLength(1);

    // The slid deadline still fires.
    afterClock.advance(5);
    await vi.waitFor(() => expect(afterRegistry.snapshot.leases).toEqual([]));
  });
});

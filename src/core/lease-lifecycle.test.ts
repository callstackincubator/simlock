import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { HeldLeaseRenewalError, LeaseLifecycle } from "./lease-lifecycle.js";
import { Registry } from "./registry.js";

const statePath = "/home/agent/.pitlane/state.json";

async function createHarness() {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: new MemoryFilesystem(),
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

  it("renews detached leases, replaces their timer, and rejects held renewal", async () => {
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

    const held = await createHarness();
    const heldLease = await held.lifecycle.grant({
      deviceId: held.device.id,
      mode: "held",
      requesterId: "agent",
    });
    await expect(held.lifecycle.renew(heldLease.lease.id, 30)).rejects.toBeInstanceOf(
      HeldLeaseRenewalError,
    );
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
});

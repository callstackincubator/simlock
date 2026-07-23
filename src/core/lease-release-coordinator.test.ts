import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import type { DeviceRecord, LeaseRecord } from "./domain.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { HeldLeaseRenewalError, LeaseLifecycle } from "./lease-lifecycle.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";
import { Registry, UnknownLeaseError, type ReleasedLease } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

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
  const scheduler = new LeaseExpiryScheduler(clock, () => undefined);
  const lifecycle = new LeaseLifecycle({
    clock,
    eventBus,
    expiryScheduler: scheduler,
    registry,
    ttl: { detachedMs: 20, heldBackstopMs: 10 },
  });
  const reclaims: ReleasedLease[] = [];
  const warmPool = {
    async reclaim(released: ReleasedLease) {
      reclaims.push(released);
    },
  };
  const coordinator = new LeaseReleaseCoordinator({
    decisions: new SerializedDecision(),
    lifecycle,
    registry,
    warmPool,
  });
  return { coordinator, eventBus, lifecycle, reclaims, registry, warmPool };
}

async function grant(
  harness: Awaited<ReturnType<typeof createHarness>>,
  mode: LeaseRecord["mode"] = "held",
): Promise<{ readonly device: DeviceRecord; readonly lease: LeaseRecord }> {
  const device = await harness.registry.registerDevice({
    driverData: {},
    driverDeviceId: `driver_${harness.registry.snapshot.devices.length}`,
    provisionDuration: 0,
    spec: { model: "Phone", osVersion: "1", platform: "ios" },
  });
  await harness.registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  const result = await harness.lifecycle.grant({
    deviceId: device.id,
    mode,
    requesterId: `agent_${device.id}`,
  });
  return result;
}

describe("LeaseReleaseCoordinator", () => {
  it.each([
    ["explicit", "lease.released"],
    ["closed", "lease.released"],
    ["killed", "lease.released"],
    ["expired", "lease.expired"],
  ] as const)("commits %s release attribution before warm reclaim", async (reason, event) => {
    const harness = await createHarness();
    const granted = await grant(harness);
    let leasesAtFact = -1;
    harness.eventBus.subscribe(event, () => {
      leasesAtFact = harness.registry.snapshot.leases.length;
    });

    if (reason === "expired") await harness.coordinator.expire(granted.lease.id);
    else await harness.coordinator.release(granted.lease.id, reason);

    expect(leasesAtFact).toBe(0);
    expect(harness.reclaims).toMatchObject([{ lease: { id: granted.lease.id } }]);
    if (event === "lease.released") {
      expect(harness.eventBus.replay()).toContainEqual(
        expect.objectContaining({ event, payload: expect.objectContaining({ reason }) }),
      );
    }
  });

  it("returns the releaseAll snapshot ids and starts warm reclaim for each", async () => {
    const harness = await createHarness();
    const first = await grant(harness);
    const second = await grant(harness);

    await expect(harness.coordinator.releaseAll("killed")).resolves.toEqual([
      first.lease.id,
      second.lease.id,
    ]);
    expect(harness.reclaims.map((released) => released.lease.id)).toEqual(
      expect.arrayContaining([first.lease.id, second.lease.id]),
    );
  });

  it("delegates detached renewal and preserves held-renewal rejection", async () => {
    const harness = await createHarness();
    const detached = await grant(harness, "detached");
    await expect(harness.coordinator.renew(detached.lease.id, 30)).resolves.toMatchObject({
      ttlDeadline: 1_030,
    });

    const heldHarness = await createHarness();
    const held = await grant(heldHarness, "held");
    await expect(heldHarness.coordinator.renew(held.lease.id, 30)).rejects.toBeInstanceOf(
      HeldLeaseRenewalError,
    );
  });

  it("does not reclaim an unknown lease", async () => {
    const harness = await createHarness();

    await expect(harness.coordinator.release("lse_missing", "explicit")).rejects.toBeInstanceOf(
      UnknownLeaseError,
    );
    expect(harness.reclaims).toEqual([]);
  });

  it("propagates warm-pool failure only after beginRelease has committed", async () => {
    const harness = await createHarness();
    const granted = await grant(harness);
    harness.warmPool.reclaim = async () => {
      expect(harness.registry.snapshot.leases).toEqual([]);
      throw new Error("reclaim failed");
    };

    await expect(harness.coordinator.release(granted.lease.id, "explicit")).rejects.toThrow(
      "reclaim failed",
    );
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "reclaiming" }]);
  });

  it("preserves concurrent releaseAll behavior: overlapping snapshots can reject", async () => {
    const harness = await createHarness();
    await grant(harness);

    const first = harness.coordinator.releaseAll("killed");
    const second = harness.coordinator.releaseAll("killed");

    await expect(Promise.all([first, second])).rejects.toBeInstanceOf(UnknownLeaseError);
  });
});

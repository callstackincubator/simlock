import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceRecord, LeaseRecord } from "./domain.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";
import { Registry, UnknownLeaseError, type ReleasedLease } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

const statePath = "/home/agent/.pitlane/state.json";

async function flush(): Promise<void> {
  for (let count = 0; count < 10; count += 1) {
    await Promise.resolve();
  }
}

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
  const claims = new DeviceOperationClaims();
  const coordinator = new LeaseReleaseCoordinator({
    claims,
    decisions: new SerializedDecision(),
    lifecycle,
    registry,
    warmPool,
  });
  return { claims, clock, coordinator, eventBus, lifecycle, reclaims, registry, warmPool };
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

  it("delegates renewal to the lifecycle for both detached and held leases", async () => {
    const harness = await createHarness();
    const detached = await grant(harness, "detached");
    await expect(harness.coordinator.renew(detached.lease.id, 30)).resolves.toMatchObject({
      ttlDeadline: 1_030,
    });

    const heldHarness = await createHarness();
    const held = await grant(heldHarness, "held");
    await expect(heldHarness.coordinator.renew(held.lease.id, 30)).resolves.toMatchObject({
      ttlDeadline: 1_030,
    });
  });

  it("delegates heartbeat to the lifecycle and slides the held lease's deadline", async () => {
    const harness = await createHarness();
    const held = await grant(harness, "held");
    expect(held.lease.ttlDeadline).toBe(1_010);

    harness.clock.advance(3);
    await expect(harness.coordinator.heartbeat(held.lease.id)).resolves.toMatchObject({
      ttlDeadline: 1_013,
    });
    expect(harness.registry.snapshot.leases).toMatchObject([{ ttlDeadline: 1_013 }]);
  });

  it("ignores an expiry delivery for a deadline replaced by renewal", async () => {
    const harness = await createHarness();
    const granted = await grant(harness, "detached");
    const staleDeadline = granted.lease.ttlDeadline;

    await harness.coordinator.renew(granted.lease.id, 30);
    await harness.coordinator.expire(granted.lease.id, staleDeadline);

    expect(harness.registry.snapshot.leases).toMatchObject([{ id: granted.lease.id }]);
    expect(harness.reclaims).toEqual([]);
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

  it("drains an active reclaim and holds new releases until maintenance reopens", async () => {
    const harness = await createHarness();
    const first = await grant(harness);
    const second = await grant(harness);
    let unblockReclaim!: () => void;
    let reclaimStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reclaimStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblockReclaim = resolve;
    });
    harness.warmPool.reclaim = async (released) => {
      harness.reclaims.push(released);
      reclaimStarted();
      await blocked;
    };

    const activeRelease = harness.coordinator.release(first.lease.id, "explicit");
    await started;
    const maintenance = harness.coordinator.beginMaintenance();
    const queuedRelease = harness.coordinator.release(second.lease.id, "explicit");

    await Promise.resolve();
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: second.lease.id }]);

    unblockReclaim();
    await activeRelease;
    await maintenance;
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: second.lease.id }]);

    await harness.coordinator.endMaintenance();
    await queuedRelease;
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("retries an expiry after maintenance reopens", async () => {
    const harness = await createHarness();
    const granted = await grant(harness, "detached");

    await harness.coordinator.beginMaintenance();
    const expiry = harness.coordinator.expire(granted.lease.id, granted.lease.ttlDeadline);
    await Promise.resolve();
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: granted.lease.id }]);

    await harness.coordinator.endMaintenance();
    await expiry;
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("preserves concurrent releaseAll behavior: overlapping snapshots can reject", async () => {
    const harness = await createHarness();
    await grant(harness);

    const first = harness.coordinator.releaseAll("killed");
    const second = harness.coordinator.releaseAll("killed");

    await expect(Promise.all([first, second])).rejects.toBeInstanceOf(UnknownLeaseError);
  });

  describe("orphaned release (#43: backgrounded reclaim)", () => {
    it("commits the registry-only release and resolves without waiting for the reclaim", async () => {
      const harness = await createHarness();
      const granted = await grant(harness);
      let unblockReclaim!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblockReclaim = resolve;
      });
      harness.warmPool.reclaim = async (released) => {
        harness.reclaims.push(released);
        await blocked;
      };

      // The registry-only half (device -> reclaiming, lease gone, `lease.released`
      // emitted) is exactly what StartupConverger's orphaned-lease release needs to
      // be fast; the driver-side reclaim is still stuck on `blocked` and this must
      // not wait for it, or nothing was gained over the old inline-await shape.
      await harness.coordinator.release(granted.lease.id, "orphaned");

      expect(harness.registry.snapshot.leases).toEqual([]);
      expect(harness.registry.snapshot.devices).toMatchObject([{ state: "reclaiming" }]);
      expect(
        harness.eventBus
          .replay()
          .some(
            (envelope) =>
              envelope.event === "lease.released" && envelope.payload.reason === "orphaned",
          ),
      ).toBe(true);

      unblockReclaim();
      await flush();
      expect(harness.reclaims).toMatchObject([{ lease: { id: granted.lease.id } }]);
    });

    it("claims the device for the background reclaim's duration, then releases the claim", async () => {
      const harness = await createHarness();
      const granted = await grant(harness);
      let unblockReclaim!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblockReclaim = resolve;
      });
      harness.warmPool.reclaim = async () => {
        await blocked;
      };

      await harness.coordinator.release(granted.lease.id, "orphaned");

      // Claimed while the reclaim is in flight -- this is what keeps
      // StartupConverger#recoverInterruptedReclaims from treating a reclaim this
      // process just started as one orphaned by a *previous* crash.
      expect(harness.claims.isClaimed(granted.device.id)).toBe(true);
      expect(harness.claims.operationFor(granted.device.id)).toBe("reclaim");

      unblockReclaim();
      await flush();
      expect(harness.claims.isClaimed(granted.device.id)).toBe(false);
    });

    it("logs and swallows a background reclaim failure instead of leaving it unhandled", async () => {
      const harness = await createHarness();
      const granted = await grant(harness);
      const sink = new MemoryLogSink();
      const logger = new JsonLinesLogger({ clock: harness.clock, level: "debug", sink });
      const failingCoordinator = new LeaseReleaseCoordinator({
        claims: harness.claims,
        decisions: new SerializedDecision(),
        lifecycle: harness.lifecycle,
        logger,
        registry: harness.registry,
        warmPool: { reclaim: async () => Promise.reject(new Error("reclaim failed")) },
      });

      // Vitest fails a test on an unhandled rejection, so simply not throwing here
      // already proves the background failure was caught, not just re-thrown late.
      await expect(
        failingCoordinator.release(granted.lease.id, "orphaned"),
      ).resolves.toBeUndefined();
      await flush();

      expect(sink.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "background reclaim failed",
          fields: expect.objectContaining({ deviceId: granted.device.id }),
        }),
      );
      expect(harness.claims.isClaimed(granted.device.id)).toBe(false);
    });
  });
});

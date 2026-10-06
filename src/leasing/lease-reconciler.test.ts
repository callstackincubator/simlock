import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import {
  DeviceOperationClaims,
  type DriverReality,
  type LeaseRecord,
  type ObservedRunState,
  type Platform,
  Registry,
  type ReleasedLease,
  SerializedDecision,
  StartupRead,
} from "../core/index.js";
import { LeaseExpiryScheduler } from "./lease-expiry-scheduler.js";
import { LeaseLifecycle } from "./lease-lifecycle.js";
import { LeaseReconciler } from "./lease-reconciler.js";
import { LeaseReleaseCoordinator } from "./lease-release-coordinator.js";

const STATE_PATH = "/home/agent/.simlock/state.json";

async function createHarness(options: { readonly ids?: readonly string[] } = {}) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const ids = [...(options.ids ?? [])];
  let nextId = 0;
  const filesystem = new MemoryFilesystem();
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: { generate: () => ids.shift() ?? `${nextId++}` },
    statePath: STATE_PATH,
  });
  const lifecycle = new LeaseLifecycle({
    clock,
    eventBus,
    expiryScheduler: new LeaseExpiryScheduler(clock, () => undefined),
    registry,
    ttl: { defaultMs: 20 },
  });
  const reclaims: ReleasedLease[] = [];
  const claims = new DeviceOperationClaims();
  const coordinator = new LeaseReleaseCoordinator({
    claims,
    decisions: new SerializedDecision(),
    lifecycle,
    notifyAvailability: () => undefined,
    registry,
    reclaim: {
      async reclaim(released: ReleasedLease) {
        reclaims.push(released);
      },
    },
  });
  const reconciler = new LeaseReconciler({ clock, ender: coordinator, registry });
  return {
    claims,
    clock,
    coordinator,
    eventBus,
    filesystem,
    lifecycle,
    reclaims,
    reconciler,
    registry,
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function leaseOn(
  harness: Harness,
  platform: Platform,
  driverDeviceId: string,
  ttlDeadline: number,
): Promise<LeaseRecord> {
  const device = await harness.registry.registerDevice({
    driverData: {},
    driverDeviceId,
    provisionDuration: 0,
    spec: { model: "Phone", osVersion: "1", platform },
  });
  await harness.registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  return harness.registry.createLease({
    deviceId: device.id,
    ownerId: `owner_${driverDeviceId}`,
    requesterId: `agent_${driverDeviceId}`,
    ttlDeadline,
    ttlMs: 60_000,
  });
}

function reality(...devices: readonly (readonly [string, ObservedRunState])[]): DriverReality {
  return {
    devices: devices.map(([deviceId, runState]) => ({
      address: `${deviceId}-address`,
      deviceId,
      driverData: {},
      runState,
    })),
    processes: [],
  };
}

function read(entries: Partial<Record<Platform, DriverReality>>): StartupRead {
  return new StartupRead(new Map(Object.entries(entries) as [Platform, DriverReality][]));
}

function eventNames(harness: Harness): string[] {
  return harness.eventBus
    .replay()
    .map((entry) => entry.event)
    .filter((name) => /^lease\.(released|expired)$|^device\.deleted$/.test(name));
}

describe("LeaseReconciler", () => {
  it("keeps the lease of a device the read says is running, and touches nothing", async () => {
    const harness = await createHarness();
    const lease = await leaseOn(harness, "ios", "d1", 5_000);

    await harness.reconciler.run(read({ ios: reality(["d1", "running"]) }));

    expect(harness.registry.snapshot.leases.map((kept) => kept.id)).toEqual([lease.id]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("leased");
    expect(eventNames(harness)).toEqual([]);
    expect(harness.reclaims).toEqual([]);
  });

  it.each(["stopped", "transitioning"] as const)(
    "ends the lease of a %s device as lease.released with reason device-lost and reclaims the device",
    async (runState) => {
      const harness = await createHarness();
      const lease = await leaseOn(harness, "ios", "d1", 5_000);

      await harness.reconciler.run(read({ ios: reality(["d1", runState]) }));
      await Promise.resolve();

      expect(harness.registry.snapshot.leases).toEqual([]);
      expect(
        harness.eventBus.replay().filter((entry) => entry.event === "lease.released"),
      ).toMatchObject([{ payload: { leaseId: lease.id, reason: "device-lost" } }]);
      expect(eventNames(harness)).toEqual(["lease.released"]);
      expect(harness.reclaims.map((released) => released.device.driverDeviceId)).toEqual(["d1"]);
      expect(harness.registry.snapshot.devices[0]?.state).toBe("reclaiming");
    },
  );

  it("marks the device of a lease missing, after lease.released and with initiator doctor, when the platform was read and lacks it, and starts no reclaim", async () => {
    const harness = await createHarness();
    const lease = await leaseOn(harness, "ios", "d1", 5_000);

    await harness.reconciler.run(read({ ios: reality(["other", "running"]) }));

    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
    expect(eventNames(harness)).toEqual(["lease.released", "device.deleted"]);
    const events = harness.eventBus.replay();
    expect(events.find((entry) => entry.event === "lease.released")?.payload).toEqual({
      deviceId: lease.deviceId,
      leaseId: lease.id,
      ownerId: lease.ownerId,
      reason: "device-lost",
    });
    expect(events.find((entry) => entry.event === "device.deleted")?.payload).toEqual({
      deviceId: lease.deviceId,
      initiator: "doctor",
    });
    expect(harness.reclaims).toEqual([]);
  });

  it("ends the lease of a device on an unreadable platform and leaves it reclaiming, with no reclaim started and no claim taken", async () => {
    const harness = await createHarness();
    const lease = await leaseOn(harness, "ios", "d1", 5_000);

    await harness.reconciler.run(read({}));
    await Promise.resolve();

    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("reclaiming");
    expect(eventNames(harness)).toEqual(["lease.released"]);
    expect(
      harness.eventBus.replay().find((entry) => entry.event === "lease.released")?.payload,
    ).toMatchObject({
      leaseId: lease.id,
      reason: "device-lost",
    });
    expect(harness.reclaims).toEqual([]);
    expect(harness.claims.isClaimed(lease.deviceId)).toBe(false);
  });

  it("judges each lease by its own platform's read, so one unreadable platform costs the other nothing", async () => {
    const harness = await createHarness();
    const ios = await leaseOn(harness, "ios", "d1", 5_000);
    const android = await leaseOn(harness, "android", "d2", 5_000);

    await harness.reconciler.run(read({ android: reality(["d2", "running"]) }));

    expect(harness.registry.snapshot.leases.map((kept) => kept.id)).toEqual([android.id]);
    expect(eventNames(harness)).toEqual(["lease.released"]);
    expect(
      harness.registry.snapshot.devices.find((device) => device.id === ios.deviceId)?.state,
    ).toBe("reclaiming");
  });

  it("looks for a device by its driverDeviceId on its own platform only", async () => {
    const harness = await createHarness();
    await leaseOn(harness, "ios", "d1", 5_000);

    await harness.reconciler.run(read({ android: reality(["d1", "running"]), ios: reality() }));

    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("deleted");
  });

  it.each([
    ["stopped", "reclaiming", 1],
    ["absent", "deleted", 0],
    ["unreadable", "reclaiming", 0],
  ] as const)(
    "ends a lease whose deadline passed as lease.expired, not lease.released, and its %s device follows the same row",
    async (reading, deviceState, reclaimCount) => {
      const harness = await createHarness();
      const lease = await leaseOn(harness, "ios", "d1", 999);
      const entries: Partial<Record<Platform, DriverReality>> =
        reading === "stopped"
          ? { ios: reality(["d1", "stopped"]) }
          : reading === "absent"
            ? { ios: reality() }
            : {};

      await harness.reconciler.run(read(entries));
      await Promise.resolve();

      expect(harness.registry.snapshot.leases).toEqual([]);
      expect(
        harness.eventBus.replay().filter((entry) => entry.event === "lease.expired"),
      ).toMatchObject([{ payload: { leaseId: lease.id } }]);
      expect(eventNames(harness)).toEqual(
        reading === "absent" ? ["lease.expired", "device.deleted"] : ["lease.expired"],
      );
      expect(harness.registry.snapshot.devices[0]?.state).toBe(deviceState);
      expect(harness.reclaims).toHaveLength(reclaimCount);
    },
  );

  it("treats a deadline equal to now as passed, and one a millisecond away as live", async () => {
    const harness = await createHarness();
    const due = await leaseOn(harness, "ios", "d1", 1_000);
    const live = await leaseOn(harness, "ios", "d2", 1_001);

    await harness.reconciler.run(read({ ios: reality(["d1", "stopped"], ["d2", "stopped"]) }));

    const names = harness.eventBus
      .replay()
      .filter((entry) => /^lease\.(released|expired)$/.test(entry.event))
      .map((entry) => [entry.event, (entry.payload as { leaseId: string }).leaseId]);
    expect(names).toEqual([
      ["lease.expired", due.id],
      ["lease.released", live.id],
    ]);
  });

  it("keeps a running lease whose deadline passed, for the expiry timers to expire through the ordinary path", async () => {
    const harness = await createHarness();
    const lease = await leaseOn(harness, "ios", "d1", 999);

    await harness.reconciler.run(read({ ios: reality(["d1", "running"]) }));

    expect(harness.registry.snapshot.leases.map((kept) => kept.id)).toEqual([lease.id]);
    expect(eventNames(harness)).toEqual([]);
  });

  it("ends the leases in deadline order, then id order, whatever order they were granted in", async () => {
    // Ids are handed out device, lease, device, lease, ...: "z" is granted first but sorts last.
    const harness = await createHarness({ ids: ["a", "z", "b", "a", "c", "m"] });
    const late = await leaseOn(harness, "ios", "d1", 5_000);
    const middle = await leaseOn(harness, "ios", "d2", 3_000);
    const early = await leaseOn(harness, "ios", "d3", 2_000);
    expect([late.id, middle.id, early.id]).toEqual(["lse_z", "lse_a", "lse_m"]);

    await harness.reconciler.run(
      read({ ios: reality(["d1", "stopped"], ["d2", "stopped"], ["d3", "stopped"]) }),
    );

    expect(
      harness.eventBus
        .replay()
        .filter((entry) => entry.event === "lease.released")
        .map((entry) => (entry.payload as { leaseId: string }).leaseId),
    ).toEqual(["lse_m", "lse_a", "lse_z"]);
  });

  it("breaks a deadline tie by lease id", async () => {
    const harness = await createHarness({ ids: ["a", "z", "b", "a"] });
    await leaseOn(harness, "ios", "d1", 5_000);
    await leaseOn(harness, "ios", "d2", 5_000);

    await harness.reconciler.run(read({ ios: reality(["d1", "stopped"], ["d2", "stopped"]) }));

    expect(
      harness.eventBus
        .replay()
        .filter((entry) => entry.event === "lease.released")
        .map((entry) => (entry.payload as { leaseId: string }).leaseId),
    ).toEqual(["lse_a", "lse_z"]);
  });

  it("leaves a lease whose device record is gone for the expiry timers, and still ends the others", async () => {
    const harness = await createHarness();
    const orphan = await leaseOn(harness, "ios", "d1", 5_000);
    const ended = await leaseOn(harness, "ios", "d2", 6_000);
    const state = JSON.parse(await harness.filesystem.readFile(STATE_PATH)) as {
      devices: { id: string }[];
    };
    await harness.filesystem.writeFileAtomic(
      STATE_PATH,
      JSON.stringify({ ...state, devices: state.devices.filter((d) => d.id !== orphan.deviceId) }),
    );
    const reloaded = await Registry.load({
      clock: harness.clock,
      eventBus: harness.eventBus,
      filesystem: harness.filesystem,
      idGenerator: { generate: () => "unused" },
      statePath: STATE_PATH,
    });
    const reconciler = new LeaseReconciler({
      clock: harness.clock,
      ender: harness.coordinator,
      registry: reloaded,
    });

    await reconciler.run(read({ ios: reality(["d2", "stopped"]) }));

    // The reconciler read the reloaded snapshot, where the orphan has no device; the ender acts on
    // the harness's own registry, where it was never touched.
    expect(harness.registry.snapshot.leases.map((kept) => kept.id)).toEqual([orphan.id]);
    expect(
      harness.eventBus
        .replay()
        .filter((entry) => entry.event === "lease.released")
        .map((entry) => (entry.payload as { leaseId: string }).leaseId),
    ).toEqual([ended.id]);
  });
});

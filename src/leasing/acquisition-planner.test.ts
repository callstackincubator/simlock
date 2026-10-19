import { describe, expect, it } from "vitest";

import { FakeSystemStats } from "../ports/index.js";
import { AcquisitionPlanner } from "./acquisition-planner.js";
import {
  CapacityCoordinator,
  type Config,
  DeviceOperationClaims,
  type PhysicalDevice,
  type VirtualDevice,
  type VirtualSpec,
  type LeaseRecord,
} from "../core/index.js";
import { createCapacityStrategy } from "../core/testing.js";

const gibibyte = 1024 ** 3;
const spec = { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const config: Config = {
  capabilities: {},
  mode: "worker",
  exec: { timeoutMs: 600_000 },
  diskPressure: { freeBytesThreshold: 10 * gibibyte },
  gateway: {
    disconnectedRetentionMs: 24 * 60 * 60_000,
    execTimeoutMs: 11 * 60_000,
    leaseRequestTimeoutMs: 5 * 60_000,
    routing: "warm-then-free" as const,
  },
  drivers: {},
  eventBuffer: { capacity: 100 },
  health: {
    enabled: true,
    maxConcurrentRecoveries: 1,
    maxRecoveryAttempts: 3,
    probeIntervalMs: 30_000,
    recoveryBackoffMs: 5_000,
    stableObservations: 2,
  },
  stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
  downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
  http: { enabled: false, host: "127.0.0.1", port: 4700 },
  ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
  android: {
    defaultModels: {},
    emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
  },
  idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
  warmPool: {
    enabled: true,
    maxConcurrentBoots: 1,
    reserveRunning: { android: 0, ios: 0 },
    targets: [],
    quarantine: {
      maxRetries: 3,
      maxRetryBackoffMs: 300_000,
      retryBackoffMs: 30_000,
      retryBackoffMultiplier: 2,
    },
  },
  lease: {
    defaultTtlMs: 100,
    maxTtlMs: 100,
    identity: { ios: "reusable", android: "reusable" },
    requestRetentionMs: 600_000,
    maxRequestRecords: 10_000,
    maxPerRequester: 1,
    endWaitMs: 600_000,
  },
  capacity: {
    strategy: "resource",
    config: {
      limits: {
        android: { maxDevices: 2, maxRunning: 2 },
        ios: { maxDevices: 1, maxRunning: 1 },
        maxRunning: 1,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    },
  },
  log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
  eventLog: {
    retention: 7 * 24 * 60 * 60 * 1000,
    maxBytes: 256 * 1024 * 1024,
  },
  metrics: { retention: 90 * 24 * 60 * 60 * 1000 },
};

function device(
  id: string,
  state: VirtualDevice["state"],
  deviceSpec: VirtualSpec = spec,
): VirtualDevice {
  return {
    physical: false,
    createdAt: 1,
    driverData: {},
    driverDeviceId: `driver-${id}`,
    id,
    spec: deviceSpec,
    mode: "full",
    state,
  };
}

function planner(
  capacityConfig: Config["capacity"] = config.capacity,
  totalRamBytes = 32 * gibibyte,
) {
  const claims = new DeviceOperationClaims();
  const capacity = new CapacityCoordinator(
    createCapacityStrategy(capacityConfig, new FakeSystemStats({ cpuCount: 8, totalRamBytes })),
  );
  return { claims, planner: new AcquisitionPlanner(capacity, claims) };
}

function plan(
  acquisitionPlanner: AcquisitionPlanner,
  devices: readonly VirtualDevice[],
  options: {
    leases?: readonly LeaseRecord[];
    noWait?: boolean;
    owner?: string;
    spec?: VirtualSpec;
  } = {},
) {
  return acquisitionPlanner.plan({
    noWait: options.noWait ?? false,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    snapshot: { devices, leases: options.leases ?? [], virtualDevices: devices },
    spec: options.spec ?? spec,
  });
}

function leaseOn(target: VirtualDevice): LeaseRecord {
  return {
    deviceId: target.id,
    grantedAt: 1,
    id: `lease-${target.id}`,
    lastRenewedAt: 1,
    idChosenByRequester: false,
    ownerId: "holder",
    requesterId: "holder",
    ttlDeadline: 100,
    ttlMs: 60_000,
  };
}

describe("AcquisitionPlanner", () => {
  it("grants a matching unclaimed ready device", () => {
    const { planner: acquisitionPlanner } = planner();
    const ready = device("ready", "ready");

    expect(plan(acquisitionPlanner, [ready])).toEqual({ device: ready, kind: "grant-ready" });
  });

  it("reserves capacity and claims a matching shutdown device for boot", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const shutdown = device("shutdown", "shutdown");
    const other = device("other", "shutdown");

    const result = plan(acquisitionPlanner, [shutdown, other]);

    expect(result).toMatchObject({ device: shutdown, kind: "boot-shutdown" });
    expect(claims.operationFor(shutdown.id)).toBe("boot");
    expect(plan(acquisitionPlanner, [shutdown, other], { noWait: true })).toEqual({
      kind: "no-capacity",
      reason: "global-running-limit",
    });
    if (result.kind === "boot-shutdown") {
      result.capacityReservation.release();
      result.claim.release();
    }
  });

  it("selects a managed same-platform victim at the device limit", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const managed = device("managed", "shutdown", { ...spec, model: "iPhone SE" });

    const result = plan(acquisitionPlanner, [managed]);

    expect(result).toMatchObject({ device: managed, kind: "evict-managed" });
    expect(claims.operationFor(managed.id)).toBe("eviction");
  });

  it("selects a warm victim when a running limit blocks provisioning", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const warm = device("warm", "ready", {
      physical: false,
      model: "Pixel 9",
      osVersion: "36",
      platform: "android",
    });

    const result = plan(acquisitionPlanner, [warm]);

    expect(result).toMatchObject({ device: warm, kind: "evict-running" });
    expect(claims.operationFor(warm.id)).toBe("eviction");
  });

  it("excludes claimed devices from ready grants and eviction candidates", () => {
    const { claims, planner: acquisitionPlanner } = planner();
    const ready = device("ready", "ready");
    const claim = claims.tryClaim(ready.id, "cleanup");
    if (claim === undefined) throw new Error("expected claim");

    expect(plan(acquisitionPlanner, [ready])).toEqual({ kind: "wait", reason: "device-limit" });
    expect(plan(acquisitionPlanner, [ready], { noWait: true })).toEqual({
      kind: "no-capacity",
      reason: "device-limit",
    });
    claim.release();
  });

  it("waits or rejects when policy cannot reserve capacity", () => {
    const { planner: acquisitionPlanner } = planner();
    const leased = device("leased", "leased");
    const leases = [
      {
        deviceId: leased.id,
        grantedAt: 1,
        id: "lease",
        requesterId: "holder",
        ownerId: "holder",
        lastRenewedAt: 1,
        idChosenByRequester: false,
        ttlMs: 60_000,
        ttlDeadline: 100,
      },
    ];

    expect(plan(acquisitionPlanner, [leased], { leases })).toEqual({
      kind: "wait",
      reason: "device-limit",
    });
    expect(plan(acquisitionPlanner, [leased], { leases, noWait: true })).toEqual({
      kind: "no-capacity",
      reason: "device-limit",
    });
  });

  it("never grants a quarantined device -- it occupies capacity like a running device without being selectable", () => {
    const { planner: acquisitionPlanner } = planner();
    // ios.maxRunning is 1 in this fixture, and RUNNING_STATES (capacity.ts) counts
    // `quarantined` as running, so this device alone exhausts the only iOS slot: no
    // fresh device can be provisioned either. AcquisitionPlanner selects by exact
    // state (`=== "ready"` / `=== "shutdown"`), never by excluding a known-bad
    // state, so quarantined is invisible to every branch with no special-casing --
    // exactly the design constraint from issue #21 / #37.
    const quarantined = device("quarantined", "quarantined");

    expect(plan(acquisitionPlanner, [quarantined])).toEqual({
      kind: "wait",
      reason: "device-limit",
    });
    expect(plan(acquisitionPlanner, [quarantined], { noWait: true })).toEqual({
      kind: "no-capacity",
      reason: "device-limit",
    });
  });

  it("never selects a spent fresh device from the ready scan or from the shutdown scan", () => {
    const unused = (state: "ready" | "shutdown") => ({
      ...device(`unused-${state}`, state),
      leaseIdentity: "fresh" as const,
    });
    const spent = (state: "ready" | "shutdown") => ({ ...unused(state), lastLeaseEndedAt: 5 });

    // Control: the same fresh records that have not served a lease yet are selected, so what
    // turns the spent ones away below is the lease they already served.
    expect(plan(planner().planner, [unused("ready")])).toMatchObject({ kind: "grant-ready" });
    expect(plan(planner().planner, [unused("shutdown")])).toMatchObject({ kind: "boot-shutdown" });

    // ios.maxDevices is 1 here, so the spent device is also the only managed eviction victim.
    expect(plan(planner().planner, [spent("ready")])).toMatchObject({ kind: "evict-managed" });
    expect(plan(planner().planner, [spent("shutdown")])).toMatchObject({ kind: "evict-managed" });
  });

  it("counts a spent fresh device against managed-device capacity until it is deleted", () => {
    const spent = {
      ...device("spent", "shutdown"),
      lastLeaseEndedAt: 5,
      leaseIdentity: "fresh" as const,
    };

    // At ios.maxDevices 1, the spent device fills the only slot: no provision is planned.
    expect(plan(planner().planner, [spent])).toMatchObject({
      device: spent,
      kind: "evict-managed",
    });

    const result = plan(planner().planner, [{ ...spent, state: "deleted" }]);
    expect(result).toMatchObject({ kind: "provision" });
    if (result.kind === "provision") result.reservation.release();
  });

  describe("RAM budget by mode", () => {
    const slimSpec: VirtualSpec = { ...spec, mode: "slim" };

    /**
     * 12 GiB of RAM: an 8 GiB budget once the 4 GiB reserve is taken. Full iOS devices take
     * 3.5 GiB, slim ones 1 GiB, Android ones 4 GiB. Running limits leave room throughout, so
     * any refusal below is the RAM budget's or the device limit's.
     */
    function sizedPlanner(iosMaxDevices: number) {
      return planner(
        {
          strategy: "resource",
          config: {
            limits: {
              android: { maxDevices: 4, maxRunning: 4 },
              ios: { maxDevices: iosMaxDevices, maxRunning: 8 },
              maxRunning: 12,
            },
            ramBudget: {
              androidBytesPerDevice: 4 * gibibyte,
              iosBytesPerDevice: 3.5 * gibibyte,
              iosSlimBytesPerDevice: gibibyte,
            },
          },
        },
        12 * gibibyte,
      );
    }

    it("needs full-size room to provision a new device, whatever its spec's mode", () => {
      const { planner: acquisitionPlanner } = sizedPlanner(8);
      const android = device("android", "leased", {
        physical: false,
        model: "Pixel 9",
        osVersion: "36",
        platform: "android",
      });
      const iosSlim = { ...device("ios-slim", "leased", slimSpec), mode: "slim" as const };
      const devices = [android, iosSlim];
      const leases = devices.map(leaseOn);

      // 5 GiB used of 8: a slim device's 1 GiB would fit, the 3.5 GiB it boots at does not.
      for (const requested of [spec, slimSpec]) {
        expect(
          plan(acquisitionPlanner, devices, { leases, noWait: true, spec: requested }),
        ).toEqual({ kind: "no-capacity", reason: "ram-budget" });
      }
      const roomy = plan(acquisitionPlanner, [iosSlim], {
        leases: [leaseOn(iosSlim)],
        noWait: true,
        spec: slimSpec,
      });
      expect(roomy).toMatchObject({ kind: "provision" });
      if (roomy.kind === "provision") roomy.reservation.release();
    });

    it("waits, and evicts nothing, when the boot of a matching shut-down slim device is refused for RAM", () => {
      const { claims, planner: acquisitionPlanner } = sizedPlanner(8);
      const android = device("android", "leased", {
        physical: false,
        model: "Pixel 9",
        osVersion: "36",
        platform: "android",
      });
      const idleOther = {
        ...device("idle-other", "ready", { ...slimSpec, osVersion: "26.0" }),
        mode: "slim" as const,
      };
      const shutdownSlim = {
        ...device("shutdown-slim", "shutdown", slimSpec),
        mode: "slim" as const,
      };
      const leases = [leaseOn(android)];

      // 6 GiB used of 8: the boot adds the 2.5 GiB between the slim and the full size.
      const devices = [android, idleOther, shutdownSlim];
      expect(plan(acquisitionPlanner, devices, { leases, spec: slimSpec })).toEqual({
        kind: "wait",
        reason: "ram-budget",
      });
      expect(plan(acquisitionPlanner, devices, { leases, noWait: true, spec: slimSpec })).toEqual({
        kind: "no-capacity",
        reason: "ram-budget",
      });
      expect(claims.isClaimed(idleOther.id)).toBe(false);
      expect(claims.isClaimed(shutdownSlim.id)).toBe(false);

      // Without the idle device, 5 GiB is used and the boot fits.
      const boot = plan(acquisitionPlanner, [android, shutdownSlim], { leases, spec: slimSpec });
      expect(boot).toMatchObject({ device: shutdownSlim, kind: "boot-shutdown" });
    });

    it("evicts an idle slim device for a full request at the device limit, then waits when the freed RAM is not enough", () => {
      const { planner: acquisitionPlanner } = sizedPlanner(2);
      const android = device("android", "leased", {
        physical: false,
        model: "Pixel 9",
        osVersion: "36",
        platform: "android",
      });
      const leasedSlim = { ...device("leased-slim", "leased", slimSpec), mode: "slim" as const };
      const idleSlim = { ...device("idle-slim", "shutdown", slimSpec), mode: "slim" as const };
      const leases = [leaseOn(android), leaseOn(leasedSlim)];

      expect(plan(acquisitionPlanner, [android, leasedSlim, idleSlim], { leases })).toMatchObject({
        device: idleSlim,
        kind: "evict-managed",
      });

      // With the slim device gone, 5 GiB is used of 8: the 3.5 GiB full device still does not fit.
      const afterEviction = [android, leasedSlim, { ...idleSlim, state: "deleted" as const }];
      expect(plan(acquisitionPlanner, afterEviction, { leases })).toEqual({
        kind: "wait",
        reason: "ram-budget",
      });
    });
  });

  describe("a device on its way", () => {
    const roomy: Config["capacity"] = {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 2, maxRunning: 2 },
          ios: { maxDevices: 3, maxRunning: 3 },
          maxRunning: 3,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    };

    it.each([
      { name: "shut-down", state: "shutdown" },
      { name: "provisioning", state: "provisioning" },
    ] as const)(
      "waits for a serving $name device under a boot claim no request owns",
      ({ state }) => {
        const { claims, planner: acquisitionPlanner } = planner(roomy);
        const onItsWay = device("on-its-way", state);
        claims.tryClaim(onItsWay.id, "boot");

        expect(plan(acquisitionPlanner, [onItsWay])).toEqual({
          kind: "wait",
          reason: "waiting-for-device",
        });
      },
    );

    it("plans as if the device were absent under noWait", () => {
      const { claims, planner: acquisitionPlanner } = planner(roomy);
      const booting = device("booting", "shutdown");
      claims.tryClaim(booting.id, "boot");

      const result = plan(acquisitionPlanner, [booting], { noWait: true });

      const absent = plan(acquisitionPlanner, [], { noWait: true });

      expect(result.kind).toBe("provision");
      expect(absent.kind).toBe("provision");
      if (result.kind === "provision") result.reservation.release();
      if (absent.kind === "provision") absent.reservation.release();
    });

    it.each([
      {
        name: "a provisioning device under a boot claim another waiter owns",
        state: "provisioning",
        claim: { kind: "boot", owner: "waiter-2" },
      },
      { name: "a provisioning device with no claim at all", state: "provisioning" },
      {
        name: "a ready device under a boot claim no request owns, which is a boot already done",
        state: "ready",
        claim: { kind: "boot" },
      },
      {
        name: "a serving device under an eviction claim",
        state: "shutdown",
        claim: { kind: "eviction" },
      },
      {
        name: "a serving device under a cleanup claim",
        state: "shutdown",
        claim: { kind: "cleanup" },
      },
      {
        name: "a device on its way in another pool mode",
        state: "shutdown",
        claim: { kind: "boot" },
        mode: "slim",
      },
    ] as const)("ignores $name and provisions", (row) => {
      const { claims, planner: acquisitionPlanner } = planner(roomy);
      const candidate = device(
        "candidate",
        row.state,
        "mode" in row ? { ...spec, mode: row.mode } : spec,
      );
      if ("claim" in row) {
        claims.tryClaim(
          candidate.id,
          row.claim.kind,
          "owner" in row.claim ? row.claim.owner : undefined,
        );
      }

      const result = plan(acquisitionPlanner, [candidate]);

      expect(result.kind).toBe("provision");
      if (result.kind === "provision") result.reservation.release();
    });

    it("grants a ready device before it waits for one on its way", () => {
      const { claims, planner: acquisitionPlanner } = planner(roomy);
      const booting = device("booting", "shutdown");
      const ready = device("ready", "ready");
      claims.tryClaim(booting.id, "boot");

      expect(plan(acquisitionPlanner, [booting, ready])).toEqual({
        device: ready,
        kind: "grant-ready",
      });
    });

    it("puts the requesting waiter's id on the boot claim it takes", () => {
      const { claims, planner: acquisitionPlanner } = planner(roomy);
      const shutdown = device("shutdown", "shutdown");

      const result = plan(acquisitionPlanner, [shutdown], { owner: "waiter-1" });

      expect(result.kind).toBe("boot-shutdown");
      expect(claims.claim(shutdown.id)).toEqual({ kind: "boot", owner: "waiter-1" });
      if (result.kind === "boot-shutdown") {
        result.capacityReservation.release();
        result.claim.release();
      }
    });
  });

  describe("why a plan is blocked", () => {
    const other = (id: string, state: VirtualDevice["state"]) =>
      device(id, state, { ...spec, model: "iPhone SE" });
    const androidSpec: VirtualSpec = {
      physical: false,
      model: "Pixel 9",
      osVersion: "36",
      platform: "android",
    };
    type Limits = {
      android: { maxDevices: number; maxRunning: number };
      ios: { maxDevices: number; maxRunning: number };
      maxRunning: number;
    };
    const capacityOf = (limits: Limits): Config["capacity"] => ({
      strategy: "resource",
      config: {
        limits,
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: 3.5 * gibibyte },
      },
    });
    const limited = (limits: Limits, totalRamBytes = 32 * gibibyte) =>
      planner(capacityOf(limits), totalRamBytes);
    const roomyLimits: Limits = {
      android: { maxDevices: 4, maxRunning: 4 },
      ios: { maxDevices: 4, maxRunning: 4 },
      maxRunning: 8,
    };

    it.each([
      {
        name: "a new device at the device limit",
        reason: "device-limit",
        build: () => ({
          made: limited({ ...roomyLimits, ios: { maxDevices: 1, maxRunning: 4 } }),
          devices: [device("leased", "leased")],
        }),
      },
      {
        name: "a new device over the RAM budget",
        reason: "ram-budget",
        build: () => ({
          made: limited(roomyLimits, 12 * gibibyte),
          devices: [
            device("a1", "leased", androidSpec),
            device("a2", "leased", { ...androidSpec, osVersion: "35" }),
          ],
        }),
      },
      {
        name: "a new device at the global running limit",
        reason: "global-running-limit",
        build: () => ({
          made: limited({ ...roomyLimits, maxRunning: 1 }),
          devices: [device("a1", "leased", androidSpec)],
        }),
      },
      {
        name: "a new device at the platform running limit",
        reason: "platform-running-limit",
        build: () => ({
          made: limited({ ...roomyLimits, ios: { maxDevices: 4, maxRunning: 1 } }),
          devices: [other("leased", "leased")],
        }),
      },
      {
        name: "the boot of a shut-down device at the global running limit",
        reason: "global-running-limit",
        build: () => ({
          made: limited({ ...roomyLimits, maxRunning: 1 }),
          devices: [device("a1", "leased", androidSpec), device("down", "shutdown")],
        }),
      },
      {
        name: "the boot of a shut-down device at the platform running limit",
        reason: "platform-running-limit",
        build: () => ({
          made: limited({ ...roomyLimits, ios: { maxDevices: 4, maxRunning: 1 } }),
          devices: [other("leased", "leased"), device("down", "shutdown")],
        }),
      },
    ] as const)("carries $reason on wait and on no-capacity for $name", (row) => {
      const { made, devices } = row.build();
      const leases = devices.filter((entry) => entry.state === "leased").map(leaseOn);

      expect(plan(made.planner, devices, { leases })).toEqual({
        kind: "wait",
        reason: row.reason,
      });
      expect(plan(made.planner, devices, { leases, noWait: true })).toEqual({
        kind: "no-capacity",
        reason: row.reason,
      });
    });

    it("carries the capacity reason that asked for an eviction on the eviction plan", () => {
      const managed = limited({ ...roomyLimits, ios: { maxDevices: 1, maxRunning: 4 } });
      const idle = other("idle", "shutdown");
      const running = limited({ ...roomyLimits, ios: { maxDevices: 4, maxRunning: 1 } });
      const warm = other("warm", "ready");

      expect(plan(managed.planner, [idle])).toMatchObject({
        device: idle,
        kind: "evict-managed",
        reason: "device-limit",
      });
      expect(plan(running.planner, [warm])).toMatchObject({
        device: warm,
        kind: "evict-running",
        reason: "platform-running-limit",
      });
    });

    class RefusesClaims extends DeviceOperationClaims {
      constructor(private readonly refused: "boot" | "eviction") {
        super();
      }

      override tryClaim(
        ...args: Parameters<DeviceOperationClaims["tryClaim"]>
      ): ReturnType<DeviceOperationClaims["tryClaim"]> {
        return args[1] === this.refused ? undefined : super.tryClaim(...args);
      }
    }

    function plannerRefusing(refused: "boot" | "eviction", limits: Limits) {
      const claims = new RefusesClaims(refused);
      const capacity = new CapacityCoordinator(
        createCapacityStrategy(
          capacityOf(limits),
          new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
        ),
      );
      return new AcquisitionPlanner(capacity, claims);
    }

    it("returns the capacity reason that asked for an eviction when the victim's claim is taken", () => {
      const atDeviceLimit = plannerRefusing("eviction", {
        ...roomyLimits,
        ios: { maxDevices: 1, maxRunning: 4 },
      });
      const atRunningLimit = plannerRefusing("eviction", {
        ...roomyLimits,
        ios: { maxDevices: 4, maxRunning: 1 },
      });

      expect(plan(atDeviceLimit, [other("idle", "shutdown")])).toEqual({
        kind: "wait",
        reason: "device-limit",
      });
      expect(plan(atRunningLimit, [other("warm", "ready")])).toEqual({
        kind: "wait",
        reason: "platform-running-limit",
      });
    });

    it("says waiting-for-device when the boot claim of a shut-down device is already taken", () => {
      const boots = plannerRefusing("boot", roomyLimits);
      const down = device("down", "shutdown");

      expect(plan(boots, [down])).toEqual({ kind: "wait", reason: "waiting-for-device" });
      expect(plan(boots, [down], { noWait: true })).toEqual({
        kind: "no-capacity",
        reason: "waiting-for-device",
      });
    });

    describe("a physical request", () => {
      const phone = (id: string, state: "ready" | "leased" = "ready"): PhysicalDevice => ({
        physical: true,
        createdAt: 1,
        driverData: {},
        driverDeviceId: `driver-${id}`,
        enrolledApps: [],
        id,
        spec: {
          class: "phone",
          physical: true,
          model: "iPhone 15 Pro",
          osVersion: "18.4",
          platform: "ios",
        },
        state,
      });
      const request = { model: "iPhone 15 Pro", platform: "ios" } as const;
      const physicalPlan = (
        devices: readonly PhysicalDevice[],
        options: { heldByOlder?: (device: PhysicalDevice) => boolean; noWait?: boolean } = {},
      ) =>
        planner().planner.planPhysical({
          absent: new Set(),
          heldByOlder: options.heldByOlder ?? (() => false),
          noWait: options.noWait ?? false,
          owner: "waiter",
          request,
          snapshot: { devices, leases: [], virtualDevices: [] },
        });

      it("is granted a ready device that fits, as the control for the reasons below", () => {
        const ready = phone("ready");

        expect(physicalPlan([ready])).toMatchObject({ device: ready, kind: "grant-physical" });
      });

      it("says behind-earlier-request when the only fits are held for an older request", () => {
        const held = phone("held");

        expect(physicalPlan([held], { heldByOlder: () => true })).toEqual({
          kind: "wait",
          reason: "behind-earlier-request",
        });
        expect(physicalPlan([held], { heldByOlder: () => true, noWait: true })).toEqual({
          kind: "no-capacity",
          reason: "behind-earlier-request",
        });
      });

      it("says no-free-physical when no ready, present device fits", () => {
        expect(physicalPlan([phone("leased", "leased")])).toEqual({
          kind: "wait",
          reason: "no-free-physical",
        });
        expect(physicalPlan([], { noWait: true })).toEqual({
          kind: "no-capacity",
          reason: "no-free-physical",
        });
      });
    });
  });
});

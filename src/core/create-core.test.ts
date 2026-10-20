import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  FakeSystemStats,
  JsonLinesLogger,
  type Logger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import {
  type Config,
  type ConfigOverrides,
  type Core,
  createCore,
  type DriverRejection,
  DriverCrashError,
  loadConfig,
  type PrerequisiteCheck,
  Registry,
} from "./index.js";
import { type FakePhysicalDevice } from "./fake-driver.js";
import { ReclaimCoordinator } from "./reclaim-coordinator.js";
import { FakeDriver, testComponentWiring } from "./testing.js";
import { WarmPool } from "./warm-pool/index.js";

async function build(
  options: {
    readonly logger?: Logger;
    readonly fresh?: boolean;
    readonly reclaimLatencyMs?: number;
    readonly driverRejections?: readonly DriverRejection[];
    readonly prerequisiteChecks?: readonly PrerequisiteCheck[];
    readonly warmTargets?: Config["warmPool"]["targets"];
    readonly physicalDevices?: readonly FakePhysicalDevice[];
    readonly overrides?: ConfigOverrides;
    readonly sink?: MemoryLogSink;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const logger =
    options.logger ??
    (options.sink === undefined ? undefined : new JsonLinesLogger({ sink: options.sink, clock }));
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({
    availableOsVersions: ["1"],
    clock,
    ...(options.reclaimLatencyMs === undefined
      ? {}
      : { latencyMs: { reclaim: options.reclaimLatencyMs } }),
    ...(options.physicalDevices === undefined ? {} : { physicalDevices: options.physicalDevices }),
    platform: "ios",
  });
  const filesystem = new MemoryFilesystem();
  const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 });
  let next = 1;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: { generate: () => `${next++}` },
    ...(options.fresh === true
      ? { leaseIdentity: { android: "fresh", ios: "fresh" } as const }
      : {}),
    statePath: "/state.json",
  });
  const core = createCore({
    clock,
    config: withWarmTargets(
      await loadConfig({
        filesystem,
        systemStats,
        ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      }),
      options.warmTargets,
    ),
    drivers: [driver],
    driverRejections: options.driverRejections,
    eventBus,
    logger,
    prerequisiteChecks: options.prerequisiteChecks,
    registry,
    systemStats,
    ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
  });
  return { clock, core, driver, registry };
}

function withWarmTargets(
  config: Config,
  targets: Config["warmPool"]["targets"] | undefined,
): Config {
  return targets === undefined ? config : { ...config, warmPool: { ...config.warmPool, targets } };
}

/** A lease the registry has just begun releasing: the device is `reclaiming`, the reclaim not yet run. */
async function releasedLease(
  { driver, registry }: Awaited<ReturnType<typeof build>>,
  options: { readonly deferReclaim?: boolean } = {},
) {
  const spec = { physical: false, model: "Phone", osVersion: "1", platform: "ios" } as const;
  const provisioned = await driver.provision(spec);
  const device = await registry.registerDevice({
    driverData: provisioned.driverData,
    driverDeviceId: provisioned.deviceId,
    provisionDuration: 0,
    spec,
  });
  await registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  const lease = await registry.createLease({
    deviceId: device.id,
    ownerId: "agent",
    requesterId: "agent",
    ttlDeadline: 61_000,
    ttlMs: 60_000,
  });
  return { device, released: await registry.beginRelease(lease.id, options) };
}

function ports(order: string[] = []): Parameters<Core["connect"]>[0] {
  return {
    leaseExpirer: {
      expire: async (leaseId) => void order.push(`leaseExpirer.expire:${leaseId}`),
    },
    leaseMaintenance: {
      acquisition: {
        beginMaintenance: async () => void order.push("acquisition.begin"),
        endMaintenance: async () => void order.push("acquisition.end"),
      },
      leases: {
        beginMaintenance: async () => void order.push("leases.begin"),
        endMaintenance: async () => void order.push("leases.end"),
        releaseAllDuringMaintenance: async (reason) => {
          order.push(`leases.releaseAll:${reason}`);
          return ["lse_1"];
        },
      },
    },
    notifyAvailability: () => void order.push("notifyAvailability"),
    warmPoolDemand: {
      maintenanceActive: false,
      resolve: async () => ({ message: "no driver", refusal: "no-driver" }),
      waitingDemand: () => [],
      defaultMode: () => "full",
    },
  };
}

describe("createCore", () => {
  it("calling nuke before connect throws an error naming the missing port", async () => {
    const { core } = await build();

    await expect(core.nuke.nuke(false)).rejects.toMatchObject({
      name: "CorePortMissingError",
      message: 'A core service was called before connect() supplied the "leaseMaintenance" port',
    });
  });

  it("a reclaim before connect throws an error naming the availability port it notifies", async () => {
    const harness = await build();
    const { released } = await releasedLease(harness);

    await expect(harness.core.reclaim.reclaim(released)).rejects.toMatchObject({
      name: "CorePortMissingError",
      message: 'A core service was called before connect() supplied the "notifyAvailability" port',
    });
  });

  it("enrolling a physical device before connect succeeds, and after connect tells the ready port its id", async () => {
    const phone: FakePhysicalDevice = {
      apps: [],
      class: "phone",
      ids: ["UDID-1"],
      model: "iPhone 15 Pro",
      osVersion: "18.4",
    };
    const before = await build({ physicalDevices: [phone] });
    await expect(before.core.enrollment.add("ios", "UDID-1")).resolves.toBeDefined();

    const after = await build({ physicalDevices: [phone] });
    const ready: string[] = [];
    after.core.connect({ ...ports(), physicalDeviceReady: (id) => void ready.push(id) });
    const result = await after.core.enrollment.add("ios", "UDID-1");

    expect(ready).toEqual([(result as unknown as { device: { id: string } }).device.id]);
  });

  it("after connect, nuke fences acquisition, then release, releases every lease, and lifts both fences in reverse", async () => {
    const { core } = await build();
    const order: string[] = [];
    core.connect(ports(order));

    const result = await core.nuke.nuke(false);

    expect(result).toEqual({ releasedLeaseIds: ["lse_1"] });
    expect(order).toEqual([
      "acquisition.begin",
      "leases.begin",
      "leases.releaseAll:killed",
      "leases.end",
      "acquisition.end",
    ]);
  });

  it("after connect, a reclaim tells acquisition the device is back", async () => {
    const harness = await build();
    const { device, released } = await releasedLease(harness);
    const order: string[] = [];
    harness.core.connect(ports(order));

    await harness.core.reclaim.reclaim(released);

    expect(order).toEqual(["notifyAvailability"]);
    expect(harness.registry.snapshot.devices).toMatchObject([{ id: device.id, state: "ready" }]);
  });

  it("doctor reports no finding on an empty registry when core was given no rejections and no checks", async () => {
    const { core } = await build();

    const report = await core.doctor.reconcile({ prerequisites: true });

    expect(report.findings).toEqual([]);
  });

  it("doctor reports the driver rejections core was given", async () => {
    const { core } = await build({
      driverRejections: [
        {
          event: "driver.root-rejected",
          payload: { platform: "android", reason: "missing-marker", root: "/Devices" },
          platform: "android",
          reason: "missing-marker",
          summary: "Refusing the android device root /Devices: it carries no marker",
        },
      ],
    });

    const report = await core.doctor.reconcile();

    expect(report.findings).toMatchObject([{ kind: "driver-unavailable", platform: "android" }]);
  });

  it("doctor reports a warm target the last pass found no runtime for, from the pool core itself keeps", async () => {
    const { core } = await build({
      warmTargets: [{ count: 1, model: "iPhone 17", osVersion: "27.0", platform: "ios" }],
    });
    core.connect({
      ...ports(),
      warmPoolDemand: {
        maintenanceActive: false,
        resolve: async () => ({ message: "iOS 27.0 is not installed", refusal: "runtime-missing" }),
        waitingDemand: () => [],
        defaultMode: () => "full",
      },
    });
    await core.passWarmPool();

    const report = await core.doctor.reconcile();

    expect(report.findings).toMatchObject([
      {
        kind: "warm-pool-target-unreachable",
        platform: "ios",
        reason: "runtime-missing",
        remedy: "run simlock component install ios 27.0",
      },
    ]);
  });

  it("the warm pool takes the mode a target with none of its own has from the connected port", async () => {
    const { core } = await build({
      warmTargets: [{ count: 1, model: "iPhone 17", platform: "ios" }],
    });
    core.connect({
      ...ports(),
      warmPoolDemand: {
        maintenanceActive: false,
        resolve: async () => ({ message: "no driver", refusal: "no-driver" }),
        waitingDemand: () => [],
        defaultMode: (platform) => (platform === "ios" ? "slim" : "full"),
      },
    });

    await core.passWarmPool();

    expect(core.warmPoolReader.figures().targets).toMatchObject([
      { mode: "slim", model: "iPhone 17" },
    ]);
  });

  it("doctor reports warm targets that add up to more than core's own running limit", async () => {
    const { core } = await build({
      warmTargets: [{ count: 1_000, model: "iPhone 17", platform: "ios" }],
    });
    core.connect(ports());

    const report = await core.doctor.reconcile();

    expect(report.findings).toMatchObject([
      { kind: "warm-pool-target-unreachable", platform: "ios", reason: "over-limit" },
      { kind: "warm-pool-target-unreachable", reason: "over-limit", target: "all targets" },
    ]);
  });

  it("doctor asks for a daemon restart on a platform whose prerequisites hold but whose driver core was not given", async () => {
    const { core } = await build({
      prerequisiteChecks: [{ check: async () => [], platform: "android" }],
    });

    const report = await core.doctor.reconcile({ prerequisites: true });

    expect(report.findings).toMatchObject([
      { kind: "prerequisite-missing", platform: "android", prerequisite: "daemon-restart" },
    ]);
  });

  it("doctor marks a foreign state change only once the decision section is free", async () => {
    const { core, driver, registry } = await build();
    const spec = { physical: false, model: "Phone", osVersion: "1", platform: "ios" } as const;
    const provisioned = await driver.provision(spec);
    const device = await registry.registerDevice({
      driverData: provisioned.driverData,
      driverDeviceId: provisioned.deviceId,
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    await registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 500_000,
      ttlMs: 60_000,
    });
    driver.setManagedReality({
      devices: [
        {
          address: provisioned.deviceId,
          deviceId: provisioned.deviceId,
          driverData: provisioned.driverData,
          runState: "stopped",
        },
      ],
      processes: [],
    });
    let open!: () => void;
    const held = core.decisions.run(
      () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    );

    const reconciled = core.doctor.reconcile();
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.snapshot.devices[0]?.foreignStateDetectedAt).toBeUndefined();
    open();
    await held;
    await reconciled;

    expect(registry.snapshot.devices[0]?.foreignStateDetectedAt).toBe(1_000);
  });

  it("doctor expires a lease past its deadline through the connected leaseExpirer port", async () => {
    const { core, driver, registry } = await build();
    const spec = { physical: false, model: "Phone", osVersion: "1", platform: "ios" } as const;
    const provisioned = await driver.provision(spec);
    const device = await registry.registerDevice({
      driverData: provisioned.driverData,
      driverDeviceId: provisioned.deviceId,
      provisionDuration: 0,
      spec,
    });
    await registry.transitionDevice(device.id, "ready", {
      event: "device.ready",
      payload: { bootDuration: 0, deviceId: device.id },
    });
    const lease = await registry.createLease({
      deviceId: device.id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 500,
      ttlMs: 60_000,
    });
    const order: string[] = [];
    core.connect(ports(order));

    await core.doctor.reconcile({ fix: true });

    expect(order).toEqual([`leaseExpirer.expire:${lease.id}`]);
  });

  it("converge restores the quarantine state once, and dispose disposes the quarantine only when called", async () => {
    const { core } = await build();
    core.connect(ports());
    const restore = vi.spyOn(core.quarantine, "restore");
    const dispose = vi.spyOn(core.quarantine, "dispose");

    await core.converge(await core.readStartup());
    expect(restore).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();

    core.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("converge leaves a deferred wipe running in the background under a claim, and settle awaits it", async () => {
    const harness = await build({ reclaimLatencyMs: 30_000 });
    const { released } = await releasedLease(harness, { deferReclaim: true });
    harness.core.connect(ports());

    const startup = await harness.core.readStartup();
    const outcome = await Promise.race([
      harness.core.converge(startup).then(() => "returned" as const),
      new Promise<"still erasing">((resolve) => setImmediate(() => resolve("still erasing"))),
    ]);

    expect(outcome).toBe("returned");
    expect(harness.registry.snapshot.devices[0]?.state).toBe("reclaiming");
    expect(harness.core.claimReader.isClaimed(released.device.id)).toBe(true);

    await new Promise((resolve) => setImmediate(resolve));
    const settled = harness.core.settle();
    harness.clock.advance(30_000);
    await settled;

    expect(harness.registry.snapshot.devices[0]?.state).toBe("ready");
    expect(harness.core.claimReader.isClaimed(released.device.id)).toBe(false);
  });

  it("settle awaits the deferred wipes before the warm pool, because a wipe's commit can start a pass", async () => {
    const harness = await build();
    harness.core.connect(ports());
    const order: string[] = [];
    vi.spyOn(ReclaimCoordinator.prototype, "settle").mockImplementation(async () => {
      order.push("reclaim");
    });
    vi.spyOn(WarmPool.prototype, "settle").mockImplementation(async () => {
      order.push("warm pool");
    });

    try {
      await harness.core.settle();
      expect(order).toEqual(["reclaim", "warm pool"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("nuke with deleteDevices waits for a deferred startup wipe, then deletes the device it left ready", async () => {
    const harness = await build({ reclaimLatencyMs: 30_000 });
    const { released } = await releasedLease(harness, { deferReclaim: true });
    // Leasing's real acquisition pauses the warm pool while maintenance is open.
    const base = ports();
    const paused = { active: false };
    harness.core.connect({
      ...base,
      leaseMaintenance: {
        ...base.leaseMaintenance,
        acquisition: {
          ...base.leaseMaintenance.acquisition,
          beginMaintenance: async () => void (paused.active = true),
        },
      },
      warmPoolDemand: {
        defaultMode: () => "full",
        get maintenanceActive() {
          return paused.active;
        },
        resolve: async () => ({ message: "no driver", refusal: "no-driver" }),
        waitingDemand: () => [],
      },
    });
    await harness.core.converge(await harness.core.readStartup());
    expect(harness.registry.snapshot.devices[0]?.state).toBe("reclaiming");
    await new Promise((resolve) => setImmediate(resolve));

    const nuked = harness.core.nuke.nuke(true);
    // Long enough for a reset that does not wait to pass the device by.
    await new Promise((resolve) => setImmediate(resolve));
    harness.clock.advance(30_000);
    await nuked;

    expect(
      harness.registry.snapshot.devices.find((device) => device.id === released.device.id)?.state,
    ).toBe("deleted");
  });

  it("logs a deferred wipe whose commit fails, releases its claim, and tells acquisition", async () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(0), level: "debug", sink });
    const harness = await build({ logger });
    const { released } = await releasedLease(harness, { deferReclaim: true });
    const order: string[] = [];
    harness.core.connect(ports(order));
    vi.spyOn(harness.registry, "transitionDevice").mockRejectedValue(new Error("write failed"));

    await harness.core.converge(await harness.core.readStartup());
    await harness.core.settle();

    expect(
      sink.records.filter((record) => record.message === "deferred wipe failed"),
    ).toMatchObject([
      { level: "error", fields: { deviceId: released.device.id, error: "write failed" } },
    ]);
    expect(harness.core.claimReader.isClaimed(released.device.id)).toBe(false);
    expect(order).toContain("notifyAvailability");
  });

  describe("startup's quarantine restore", () => {
    async function quarantinedDevice(options: { readonly platformReadable: boolean }) {
      const harness = await build();
      if (!options.platformReadable) {
        harness.driver.failOn("listManaged", 1, new DriverCrashError("cannot list"));
      }
      // A device whose release-time purge failed in a previous process, its retry already due.
      const { released } = await releasedLease(harness);
      await harness.registry.enterQuarantine(released.device.id, 0, { kind: "purge-failed" });
      harness.core.connect(ports());
      await harness.core.converge(await harness.core.readStartup());
      // Lets a retry timer that converge armed fire.
      harness.clock.advance(1);
      await new Promise((resolve) => setImmediate(resolve));
      const reclaims = harness.driver.calls.filter((call) => call.operation === "reclaim");
      return { ...harness, reclaims };
    }

    it("re-arms the retry of a quarantined device on a platform the read could list", async () => {
      const { reclaims } = await quarantinedDevice({ platformReadable: true });

      expect(reclaims).toHaveLength(1);
    });

    it("leaves a quarantined device on a platform the read could not list alone: no retry runs", async () => {
      const { reclaims } = await quarantinedDevice({ platformReadable: false });

      expect(reclaims).toHaveLength(0);
    });
  });

  it("logs a spent device it cannot delete at startup and keeps going, leaving the device shut down", async () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(0), level: "debug", sink });
    const harness = await build({ fresh: true, logger });
    harness.driver.failOn("destroy", 1, new DriverCrashError("cannot delete"));
    // A fresh device whose lease ended and whose previous process stopped before deleting it.
    const { device, released } = await releasedLease(harness);
    await harness.registry.completeReclaimWithoutPurge(released.device.id);
    harness.core.connect(ports());

    await harness.core.converge(await harness.core.readStartup());

    expect(
      sink.records.filter((record) => record.message === "startup delete of a spent device failed"),
    ).toMatchObject([{ level: "error", fields: { deviceId: device.id, error: "cannot delete" } }]);
    expect(harness.registry.snapshot.devices).toMatchObject([{ id: device.id, state: "shutdown" }]);
  });

  it("logs an orphan device the doctor cannot purge through the logger createCore was given", async () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(0), level: "debug", sink });
    const { core, driver } = await build({ logger });
    driver.setManagedReality({
      devices: [
        {
          address: "orphan-address",
          deviceId: "orphan-1",
          driverData: { fakeDeviceId: "orphan-1" },
          runState: "stopped",
        },
      ],
      processes: [],
    });
    driver.failOn("destroy", 1, new DriverCrashError("cannot purge"));
    core.connect(ports());

    await core.doctor.reconcile({ purgeOrphans: true });

    expect(
      sink.records.filter((record) => record.message === "Could not purge orphan device"),
    ).toMatchObject([{ level: "error", fields: { platform: "ios", reason: "cannot purge" } }]);
  });

  it("keeps going when a spent device cannot be deleted at startup and no logger was given", async () => {
    const harness = await build({ fresh: true });
    harness.driver.failOn("destroy", 1, new DriverCrashError("cannot delete"));
    const { device, released } = await releasedLease(harness);
    await harness.registry.completeReclaimWithoutPurge(released.device.id);
    harness.core.connect(ports());

    await expect(harness.core.converge(await harness.core.readStartup())).resolves.toBeUndefined();

    expect(harness.registry.snapshot.devices).toMatchObject([{ id: device.id, state: "shutdown" }]);
  });

  describe("the warm pool over budget with a device on a platform that has no driver", () => {
    // why: one tick plus a second, because a failed shutdown pauses its device for exactly a
    // tick; advancing to the tick's end or less would let a pass decline the proposal without
    // acting on it at all.
    const PAST_A_TICK = 31_000;

    async function overBudgetWithARefusedPlatformsDeviceFirst() {
      const sink = new MemoryLogSink();
      const rig = await build({
        overrides: { capacity: { config: { maxRunning: 1 }, strategy: "fixed" } },
        sink,
      });
      rig.core.connect(ports());

      const ghost = await rig.registry.registerDevice({
        driverData: {},
        driverDeviceId: "ghost-android",
        provisionDuration: 0,
        spec: { model: "Pixel 8", osVersion: "35", physical: false, platform: "android" },
      });
      await rig.registry.transitionDevice(ghost.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: ghost.id },
      });
      rig.clock.advance(1_000);

      const bootable = await rig.driver.provision({
        model: "Phone",
        osVersion: "1",
        physical: false,
        platform: "ios",
      });
      const idle = await rig.registry.registerDevice({
        driverData: bootable.driverData,
        driverDeviceId: bootable.deviceId,
        provisionDuration: 0,
        spec: { model: "Phone", osVersion: "1", physical: false, platform: "ios" },
      });
      await rig.registry.transitionDevice(idle.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: idle.id },
      });

      const shutdownCalls = () =>
        rig.driver.calls
          .filter((call) => call.operation === "shutdown")
          .map((call) => (call.arguments[0] as { deviceId: string }).deviceId);
      const failureLines = () =>
        sink.records.filter(
          (record) =>
            record.level === "warn" && record.message === "warm pool shutdown of a device failed",
        );
      const stateOf = (deviceId: string) =>
        rig.registry.snapshot.devices.find((device) => device.id === deviceId)?.state;
      return { ...rig, failureLines, ghost, healthy: idle, shutdownCalls, stateOf };
    }

    it("leaves a device of a platform with no driver out of the shutdown choice, shutting down the next least recently used device and coming back under budget", async () => {
      const rig = await overBudgetWithARefusedPlatformsDeviceFirst();

      await rig.core.passWarmPool();
      await rig.core.settle();
      rig.clock.advance(PAST_A_TICK);
      await rig.core.passWarmPool();
      await rig.core.settle();
      rig.clock.advance(PAST_A_TICK);
      await rig.core.passWarmPool();
      await rig.core.settle();

      expect(rig.shutdownCalls()).toEqual([rig.healthy.driverDeviceId]);
      expect(rig.stateOf(rig.healthy.id)).toBe("shutdown");
      expect(rig.stateOf(rig.ghost.id)).toBe("ready");
      expect(rig.failureLines()).toEqual([]);
      expect(rig.core.capacityReader.runningCapacity.global.overLimit).toBe(false);
    });
  });
});

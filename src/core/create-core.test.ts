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
  type Core,
  createCore,
  type DriverRejection,
  DriverCrashError,
  loadConfig,
  type PrerequisiteCheck,
  Registry,
} from "./index.js";
import { FakeDriver, testComponentWiring } from "./testing.js";

async function build(
  options: {
    readonly logger?: Logger;
    readonly fresh?: boolean;
    readonly driverRejections?: readonly DriverRejection[];
    readonly prerequisiteChecks?: readonly PrerequisiteCheck[];
    readonly warmTargets?: Config["warmPool"]["targets"];
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({ availableOsVersions: ["1"], clock, platform: "ios" });
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
    config: withWarmTargets(await loadConfig({ filesystem, systemStats }), options.warmTargets),
    drivers: [driver],
    driverRejections: options.driverRejections,
    eventBus,
    logger: options.logger,
    prerequisiteChecks: options.prerequisiteChecks,
    registry,
    systemStats,
    ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
  });
  return { core, driver, registry };
}

function withWarmTargets(
  config: Config,
  targets: Config["warmPool"]["targets"] | undefined,
): Config {
  return targets === undefined ? config : { ...config, warmPool: { ...config.warmPool, targets } };
}

/** A lease the registry has just begun releasing: the device is `reclaiming`, the reclaim not yet run. */
async function releasedLease({ driver, registry }: Awaited<ReturnType<typeof build>>) {
  const spec = { model: "Phone", osVersion: "1", platform: "ios" } as const;
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
  return { device, released: await registry.beginRelease(lease.id) };
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

  it("doctor expires a lease past its deadline through the connected leaseExpirer port", async () => {
    const { core, driver, registry } = await build();
    const spec = { model: "Phone", osVersion: "1", platform: "ios" } as const;
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

    await core.converge();
    expect(restore).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();

    core.dispose();
    expect(dispose).toHaveBeenCalledOnce();
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

    await harness.core.converge();

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

    await expect(harness.core.converge()).resolves.toBeUndefined();

    expect(harness.registry.snapshot.devices).toMatchObject([{ id: device.id, state: "shutdown" }]);
  });
});

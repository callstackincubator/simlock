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
import { type Core, createCore, DriverCrashError, loadConfig, Registry } from "./index.js";
import { FakeDriver, testComponentWiring } from "./testing.js";

async function build(options: { readonly logger?: Logger; readonly fresh?: boolean } = {}) {
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
    config: await loadConfig({ filesystem, systemStats }),
    drivers: [driver],
    eventBus,
    logger: options.logger,
    registry,
    systemStats,
    ...testComponentWiring({ clock, drivers: [driver], eventBus, registry }),
  });
  return { core, driver, registry };
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
    queueHeadDemand: () => {
      order.push("queueHeadDemand");
      return undefined;
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

  it("a reclaim before connect throws an error naming the queue-head port its keep decision reads", async () => {
    const harness = await build();
    const { released } = await releasedLease(harness);

    await expect(harness.core.warmPool.reclaim(released)).rejects.toMatchObject({
      name: "CorePortMissingError",
      message: 'A core service was called before connect() supplied the "queueHeadDemand" port',
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

  it("after connect, a reclaim reads the queue head's spec and then tells acquisition the device is back", async () => {
    const harness = await build();
    const { device, released } = await releasedLease(harness);
    const order: string[] = [];
    harness.core.connect(ports(order));

    await harness.core.warmPool.reclaim(released);

    expect(order).toEqual(["queueHeadDemand", "notifyAvailability"]);
    expect(harness.registry.snapshot.devices).toMatchObject([{ id: device.id, state: "ready" }]);
  });

  it("converge re-arms the quarantine retry timers, and dispose cancels the ones armed", async () => {
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

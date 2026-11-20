import { afterEach, describe, expect, it, vi } from "vitest";
import { type PhysicalDevice } from "../core/index.js";
import {
  type Harness,
  absentHarness,
  absentReasonOf,
  asking,
  back,
  createHarness,
  enrollIphone,
  eventsOf,
  flush,
  gone,
  harnesses,
  holdNextReclaim,
  isSettled,
  markAbsent,
  physicalRequest,
  readsOf,
  reclaimCalls,
  recordStateWrites,
  reopen,
  startWatcher,
  stateOf,
  tick,
  watcherOf,
} from "./test-physical-device-watcher.js";

const DAY_MS = 24 * 60 * 60_000;

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    watcherOf(harness)?.dispose();
    harness.engine.dispose();
  }
});

describe("PhysicalDeviceWatcher around restarts and doctor", () => {
  it("a device left reclaiming by a killed daemon, read present, whose re-run reclaim fails: still present, it is quarantined with device.quarantined only; read not present after the failure, it is absent with device.absence-detected previousState reclaiming", async () => {
    const restarted = async () => {
      const first = await createHarness();
      const device = await enrollIphone(first, "UDID-A");
      await first.registry.transitionDevice(device.id, "leased");
      await first.registry.transitionDevice(device.id, "reclaiming");
      const harness = await reopen(first, () => undefined);
      back(harness, "UDID-A");
      await harness.engine.convergeRunningCapacity();
      return { device, harness };
    };

    const present = await restarted();
    vi.spyOn(present.harness.driver, "reclaim").mockRejectedValueOnce(
      new Error("uninstall failed"),
    );
    startWatcher(present.harness);
    await tick(present.harness);
    expect(stateOf(present.harness, present.device)).toBe("quarantined");
    expect(eventsOf(present.harness, "device.quarantined")).toHaveLength(1);
    expect(eventsOf(present.harness, "device.purge-failed")).toEqual([]);
    expect(eventsOf(present.harness, "device.absence-detected")).toEqual([]);

    const unplugged = await restarted();
    vi.spyOn(unplugged.harness.driver, "reclaim").mockImplementationOnce(async () => {
      gone(unplugged.harness, "UDID-A");
      throw new Error("usb lost");
    });
    startWatcher(unplugged.harness);
    await tick(unplugged.harness);
    expect(stateOf(unplugged.harness, unplugged.device)).toBe("absent");
    expect(eventsOf(unplugged.harness, "device.absence-detected")).toMatchObject([
      {
        payload: {
          absentReason: "not-present",
          deviceId: unplugged.device.id,
          previousState: "reclaiming",
        },
      },
    ]);
    expect(eventsOf(unplugged.harness, "device.quarantined")).toEqual([]);
    expect(eventsOf(unplugged.harness, "device.purge-failed")).toEqual([]);
  });

  it("a physical device that entered reclaiming in this process and holds no claim is never reclaimed by the watcher", async () => {
    const first = await createHarness();
    const restartedDevice = await enrollIphone(first, "UDID-A");
    const processDevice = await enrollIphone(first, "UDID-B");
    await first.registry.transitionDevice(restartedDevice.id, "leased");
    await first.registry.transitionDevice(restartedDevice.id, "reclaiming");
    const harness = await reopen(first, () => undefined);
    back(harness, "UDID-A");
    back(harness, "UDID-B");
    await harness.engine.convergeRunningCapacity();
    await harness.registry.transitionDevice(processDevice.id, "leased");
    await harness.registry.transitionDevice(processDevice.id, "reclaiming");
    startWatcher(harness);

    await tick(harness, 3);

    expect(stateOf(harness, restartedDevice)).toBe("ready");
    expect(stateOf(harness, processDevice)).toBe("reclaiming");
    expect(
      reclaimCalls(harness.driver).filter((call) =>
        JSON.stringify(call.arguments).includes("UDID-B"),
      ),
    ).toEqual([]);
  });

  it("a device left reclaiming by a killed daemon that left reclaiming before the first tick, and entered it again in this process, is never reclaimed by the watcher", async () => {
    const first = await createHarness();
    const device = await enrollIphone(first, "UDID-A");
    await first.registry.transitionDevice(device.id, "leased");
    await first.registry.transitionDevice(device.id, "reclaiming");
    const harness = await reopen(first, () => undefined);
    back(harness, "UDID-A");
    await harness.engine.convergeRunningCapacity();
    await harness.registry.transitionDevice(device.id, "ready", {
      event: "device.reclaimed",
      payload: { deviceId: device.id, duration: 0, strategy: "uninstall" },
    });
    startWatcher(harness);
    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
    expect(reclaimCalls(harness.driver)).toEqual([]);

    await harness.registry.transitionDevice(device.id, "leased");
    await harness.registry.transitionDevice(device.id, "reclaiming");
    await tick(harness, 2);

    expect(readsOf(harness.driver)).toHaveLength(3);
    expect(stateOf(harness, device)).toBe("reclaiming");
    expect(reclaimCalls(harness.driver)).toEqual([]);
  });

  it("a device left reclaiming by a killed daemon that doctor --fix quarantines before the watcher's tick stays quarantined, and the watcher runs no reclaim on it", async () => {
    const options = { quarantineBackoffMs: 10 * DAY_MS };
    const first = await createHarness(options);
    const device = await enrollIphone(first, "UDID-A");
    await first.registry.transitionDevice(device.id, "leased");
    await first.registry.transitionDevice(device.id, "reclaiming");
    const harness = await reopen(
      first,
      (database) => {
        database.exec("UPDATE devices SET last_lease_ended_at = 1");
      },
      options,
    );
    await harness.engine.convergeRunningCapacity();
    harness.clock.advance(DAY_MS);
    await harness.engine.core.doctor.reconcile({ fix: true });
    expect(stateOf(harness, device)).toBe("quarantined");
    back(harness, "UDID-A");
    startWatcher(harness);

    await tick(harness, 3);

    expect(readsOf(harness.driver)).toContainEqual(["UDID-A"]);
    expect(stateOf(harness, device)).toBe("quarantined");
    expect(reclaimCalls(harness.driver)).toEqual([]);
  });
});

describe("PhysicalDeviceWatcher and nuke maintenance", () => {
  it("the device-lost ending waits while nuke maintenance is active, and runs when it ends", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    await harness.engine.request(physicalRequest, asking("agent"));
    gone(harness, "UDID-A");
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();

    await tick(harness, 3);
    expect(readsOf(harness.driver).length).toBeGreaterThan(0);
    expect(stateOf(harness, device)).toBe("leased");
    expect(harness.registry.snapshot.leases).toHaveLength(1);

    await maintenance.endMaintenance();
    await flush();
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(eventsOf(harness, "lease.released")).toMatchObject([
      { payload: { reason: "device-lost" } },
    ]);
  });

  it("while nuke maintenance is active, a ready device past the grace period stays ready, an absent device read with another reason keeps its old one, and an absent device read present gets no write and no reclaim; all three are acted on once maintenance ends", async () => {
    const options = { health: { stableObservations: 3 } };
    const first = await createHarness(options);
    const ready = await enrollIphone(first, "UDID-R");
    const reasoned = await enrollIphone(first, "UDID-X");
    const returned = await enrollIphone(first, "UDID-Y");
    const harness = await reopen(
      first,
      (database) => {
        markAbsent(database, "UDID-X", "locked");
        markAbsent(database, "UDID-Y", "locked");
      },
      options,
    );
    gone(harness, "UDID-R");
    gone(harness, "UDID-X", "locked");
    gone(harness, "UDID-Y", "locked");
    startWatcher(harness);
    await tick(harness, 2);
    const writes = recordStateWrites(harness);
    gone(harness, "UDID-X", "not-present");
    back(harness, "UDID-Y");
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();

    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(3);
    expect(stateOf(harness, ready)).toBe("ready");
    expect(absentReasonOf(harness, reasoned)).toBe("locked");
    expect(stateOf(harness, returned)).toBe("absent");
    expect(writes).toHaveLength(0);
    expect(reclaimCalls(harness.driver)).toHaveLength(0);

    await maintenance.endMaintenance();
    await flush();
    await tick(harness);
    expect(stateOf(harness, ready)).toBe("absent");
    expect(absentReasonOf(harness, reasoned)).toBe("not-present");
    expect(reclaimCalls(harness.driver)).toHaveLength(1);
    expect(["reclaiming", "ready"]).toContain(stateOf(harness, returned));
  });

  it.each([
    {
      name: "nuke's lease maintenance, begun while it runs,",
      start: (harness: Harness) =>
        harness.engine.leasing.corePorts.leaseMaintenance.leases.beginMaintenance(),
      finish: async (harness: Harness) => {
        await harness.engine.leasing.corePorts.leaseMaintenance.leases.endMaintenance();
      },
    },
    {
      name: "leasing.settle()",
      start: (harness: Harness) => harness.engine.leasing.settle(),
      finish: async (harness: Harness, device: PhysicalDevice) => {
        expect(stateOf(harness, device)).toBe("ready");
      },
    },
  ])("$name resolves only after a return reclaim the watcher started has settled", async (row) => {
    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    const gate = holdNextReclaim(harness);
    startWatcher(harness);
    await tick(harness);
    expect(reclaimCalls(harness.driver)).toHaveLength(1);

    const waiting = row.start(harness);
    expect(await isSettled(waiting)).toBe(false);

    gate.resolve();
    expect(await isSettled(waiting)).toBe(true);
    await row.finish(harness, device);
  });

  it("an absentReason rewrite held back by nuke maintenance is dropped when the watcher is disposed before maintenance ends", async () => {
    const { device, harness } = await absentHarness("locked");
    gone(harness, "UDID-A", "not-present");
    startWatcher(harness);
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();
    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(1);

    watcherOf(harness)?.dispose();
    await maintenance.endMaintenance();
    await flush();

    expect(absentReasonOf(harness, device)).toBe("locked");
  });

  it("a return reclaim waiting on nuke maintenance when the watcher is disposed never starts: the device stays absent", async () => {
    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    startWatcher(harness);
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();
    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(1);

    watcherOf(harness)?.dispose();
    await maintenance.endMaintenance();
    await flush();

    expect(stateOf(harness, device)).toBe("absent");
    expect(reclaimCalls(harness.driver)).toHaveLength(0);
  });

  it("a device-lost ending waiting on nuke maintenance when the watcher is disposed leaves the lease in place", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    await harness.engine.request(physicalRequest, asking("agent"));
    gone(harness, "UDID-A");
    await tick(harness);
    const maintenance = harness.engine.leasing.corePorts.leaseMaintenance.leases;
    await maintenance.beginMaintenance();
    await tick(harness);
    expect(readsOf(harness.driver).length).toBeGreaterThan(1);

    watcherOf(harness)?.dispose();
    await maintenance.endMaintenance();
    await flush();

    expect(stateOf(harness, device)).toBe("leased");
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../core/index.js";
import {
  PROBE_MS,
  absentReasonOf,
  answer,
  asking,
  back,
  createHarness,
  enrollIphone,
  flush,
  gone,
  harnesses,
  holdNextReclaim,
  physicalRequest,
  readsOf,
  recordStateWrites,
  startWatcher,
  stateOf,
  tick,
  watcherOf,
} from "./test-physical-device-watcher.js";

async function oneNotPresentReadThenReady(
  options: { readonly failFirstReclaim: boolean } = { failFirstReclaim: false },
) {
  const harness = await createHarness({ quarantineBackoffMs: 10_000 });
  const device = await enrollIphone(harness, "UDID-A");
  startWatcher(harness);
  gone(harness, "UDID-A");
  await tick(harness);
  expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
  back(harness, "UDID-A");
  if (options.failFirstReclaim) harness.driver.failOn("reclaim", 1, new Error("uninstall failed"));
  const grant = await harness.engine.request(physicalRequest, asking("agent"));
  await harness.engine.release(grant.lease.id, "explicit");
  await flush();
  return { device, harness };
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    watcherOf(harness)?.dispose();
    harness.engine.dispose();
  }
});

describe("PhysicalDeviceWatcher counting", () => {
  it("a present read between not-present reads sets the count back to 0", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);

    gone(harness, "UDID-A");
    await tick(harness);
    back(harness, "UDID-A");
    await tick(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a read that takes longer than health.probeIntervalMs delays the next tick, and no two reads of one platform overlap", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    harness.driver.holdPresenceReads("UDID-A");
    startWatcher(harness);

    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);

    for (let count = 0; count < 3; count += 1) {
      harness.clock.advance(PROBE_MS);
      await flush();
    }
    expect(readsOf(harness.driver)).toHaveLength(1);

    harness.driver.releasePresenceReads();
    await flush();
    harness.clock.advance(PROBE_MS - 1);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(1);

    harness.clock.advance(1);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(2);
  });

  it("each read asks the driver only for the driverDeviceId, and the hardwareSerial when it has one, of that platform's enrolled records, deleted ones left out", async () => {
    const harness = await createHarness({ android: true });
    await enrollIphone(harness, "UDID-A");
    const removed = await enrollIphone(harness, "UDID-B");
    await harness.registry.unenrollPhysical(removed.id);
    await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "EMU-1",
      hardwareSerial: "SER-1",
      model: "Pixel 8",
      osVersion: "14",
      platform: "android",
    });
    harness.androidDriver.setPhysicalPresence("EMU-1", true);
    startWatcher(harness);

    await tick(harness);

    expect(readsOf(harness.driver)).toEqual([[{ driverDeviceId: "UDID-A" }]]);
    expect(readsOf(harness.androidDriver)).toEqual([
      [{ driverDeviceId: "EMU-1", hardwareSerial: "SER-1" }],
    ]);
  });

  it("a read that rejects changes neither the count nor the state of that platform's devices", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    harness.driver.failOn("listPresentPhysical", 2, new Error("devicectl: timed out"));
    startWatcher(harness);
    gone(harness, "UDID-A");

    await tick(harness);
    await tick(harness);
    expect(readsOf(harness.driver)).toHaveLength(2);
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a device with no entry in the driver's answer counts as not present, with reason not-present", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    vi.spyOn(harness.driver, "listPresentPhysical").mockResolvedValue(answer([]));
    startWatcher(harness);

    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);

    expect(stateOf(harness, device)).toBe("absent");
    expect(absentReasonOf(harness, device)).toBe("not-present");
  });

  it("a device read not present locked and then not-present becomes absent with the last read's reason", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);

    gone(harness, "UDID-A", "locked");
    await tick(harness);
    gone(harness, "UDID-A", "not-present");
    await tick(harness);

    expect(stateOf(harness, device)).toBe("absent");
    expect(absentReasonOf(harness, device)).toBe("not-present");
  });

  it("a device with one not-present read that then enters ready (through a reclaim, a quarantine recovery, or device add) starts its count at 0: one more not-present read leaves it ready", async () => {
    const reclaimed = await oneNotPresentReadThenReady();
    expect(stateOf(reclaimed.harness, reclaimed.device)).toBe("ready");
    gone(reclaimed.harness, "UDID-A");
    await tick(reclaimed.harness);
    expect(stateOf(reclaimed.harness, reclaimed.device)).toBe("ready");
    await tick(reclaimed.harness);
    expect(stateOf(reclaimed.harness, reclaimed.device)).toBe("absent");

    const recovered = await oneNotPresentReadThenReady({ failFirstReclaim: true });
    expect(stateOf(recovered.harness, recovered.device)).toBe("quarantined");
    recovered.harness.clock.advance(10_000);
    await flush();
    expect(stateOf(recovered.harness, recovered.device)).toBe("ready");
    gone(recovered.harness, "UDID-A");
    await tick(recovered.harness);
    expect(stateOf(recovered.harness, recovered.device)).toBe("ready");
    await tick(recovered.harness);
    expect(stateOf(recovered.harness, recovered.device)).toBe("absent");

    const added = await oneNotPresentReadThenReady({ failFirstReclaim: true });
    expect(stateOf(added.harness, added.device)).toBe("quarantined");
    added.harness.driver.setPhysicalDevices([{ ids: ["UDID-A"], model: "iPhone 15 Pro" }]);
    await added.harness.engine.core.enrollment.add("ios", "UDID-A");
    expect(stateOf(added.harness, added.device)).toBe("ready");
    gone(added.harness, "UDID-A");
    await tick(added.harness);
    expect(stateOf(added.harness, added.device)).toBe("ready");
    await tick(added.harness);
    expect(stateOf(added.harness, added.device)).toBe("absent");
  });

  it("a tick whose read starts before a reclaim commits ready, and resolves not present after that commit, does not count that read: with health.stableObservations 2, one more not-present read leaves the device ready", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    const grant = await harness.engine.request(physicalRequest, asking("agent"));
    harness.driver.holdPresenceReads("UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(2);
    const reclaim = holdNextReclaim(harness);
    await harness.engine.release(grant.lease.id, "explicit");
    await flush();
    expect(stateOf(harness, device)).toBe("reclaiming");
    reclaim.resolve();
    await flush();
    expect(stateOf(harness, device)).toBe("ready");
    gone(harness, "UDID-A");
    harness.driver.releasePresenceReads();
    await flush();
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a read begun while a device was ready, that resolves not present after the device is re-enrolled, does not count: with health.stableObservations 2, one more not-present read leaves it ready", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    harness.driver.holdPresenceReads("UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(2);
    harness.driver.setPhysicalDevices([{ ids: ["UDID-A"], model: "iPhone 15 Pro" }]);
    await harness.engine.core.enrollment.add("ios", "UDID-A");

    harness.driver.releasePresenceReads();
    await flush();
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");

    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("starting the watcher twice arms one timer: one health.probeIntervalMs later the platform has been read once", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    startWatcher(harness);

    await tick(harness);

    expect(readsOf(harness.driver)).toHaveLength(1);
  });

  it("a watcher started after it was disposed reads nothing", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    watcherOf(harness)?.dispose();
    startWatcher(harness);

    await tick(harness, 3);

    expect(readsOf(harness.driver)).toEqual([]);
  });

  it("no device action is attempted when a read rejects", async () => {
    const harness = await createHarness({ health: { stableObservations: 1 } });
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    harness.driver.failOn("listPresentPhysical", 1, new Error("devicectl: timed out"));
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness);

    expect(readsOf(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, device)).toBe("ready");
    expect(writes).toHaveLength(0);
  });

  it("a tick that throws outside any device action still arms the next tick", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const original = Object.getOwnPropertyDescriptor(Registry.prototype, "snapshot")?.get;
    let thrown = false;
    const spy = vi.spyOn(harness.registry, "snapshot", "get").mockImplementation(function (
      this: Registry,
    ) {
      if (!thrown && new Error().stack?.includes("physical-device-watcher.ts:") === true) {
        thrown = true;
        throw new Error("snapshot unavailable");
      }
      return original?.call(this) as never;
    });
    startWatcher(harness);

    await tick(harness);
    spy.mockRestore();

    expect(thrown).toBe(true);
    await tick(harness);
    expect(stateOf(harness, device)).toBe("ready");
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import * as coreModule from "../core/index.js";
import { type LeaseGrant } from "../core/index.js";
import { FakeClock, JsonLinesLogger, type Logger, MemoryLogSink } from "../ports/index.js";
import {
  PROBE_MS,
  absentHarness,
  absentReasonOf,
  answer,
  asking,
  back,
  createHarness,
  deferred,
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

const latestPresence = (driverDeviceId: string): unknown =>
  (coreModule as unknown as Record<string, (id: string) => unknown>)["latestPresence"]?.(
    driverDeviceId,
  );

async function outcome(promise: Promise<LeaseGrant>): Promise<LeaseGrant | Error | "pending"> {
  return Promise.race([
    promise.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
    flush().then(() => "pending" as const),
  ]);
}

function capturingLogger(): { readonly logger: Logger; readonly sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { logger: new JsonLinesLogger({ clock: new FakeClock(1_000), sink }), sink };
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    watcherOf(harness)?.dispose();
    harness.engine.dispose();
  }
});

describe("PhysicalDeviceWatcher acting on a device", () => {
  it("an absent device read not present with another reason gets its absentReason rewritten in one registry write, with no event; a read with the same reason writes nothing", async () => {
    const { device, harness } = await absentHarness("locked");
    gone(harness, "UDID-A", "locked");
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
    expect(writes).toHaveLength(0);
    expect(absentReasonOf(harness, device)).toBe("locked");

    gone(harness, "UDID-A", "not-present");
    const eventsBefore = harness.bus.replay().length;
    await tick(harness);
    expect(absentReasonOf(harness, device)).toBe("not-present");
    expect(writes).toHaveLength(1);
    expect(harness.bus.replay()).toHaveLength(eventsBefore);

    await tick(harness);
    expect(writes).toHaveLength(1);
    expect(absentReasonOf(harness, device)).toBe("not-present");
  });

  it("a device under an operation claim read not present past the grace period keeps its state; the first tick after the claim is released moves it", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const claim = harness.engine.core.claims.tryClaim(device.id, "enrollment");
    expect(claim).toBeDefined();
    startWatcher(harness);

    await tick(harness, 3);
    expect(readsOf(harness.driver)).toHaveLength(3);
    expect(stateOf(harness, device)).toBe("ready");

    claim?.release();
    await tick(harness);
    expect(stateOf(harness, device)).toBe("absent");
  });

  it("a grant that commits between the watcher's read and its write leaves the new lease in place", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);

    back(harness, "UDID-A");
    const gate = deferred();
    vi.spyOn(harness.driver, "listPresentPhysical").mockImplementationOnce(async (enrolled) => {
      await gate.promise;
      return answer(
        enrolled.map(({ driverDeviceId }) => ({
          driverDeviceId,
          present: false,
          reason: "not-present",
        })),
      );
    });
    harness.clock.advance(PROBE_MS);
    await flush();
    const granted = await outcome(harness.engine.request(physicalRequest, asking("agent")));
    expect(granted).toMatchObject({ device: { id: device.id } });
    gate.resolve();
    await flush();

    expect(stateOf(harness, device)).toBe("leased");
    expect(harness.registry.snapshot.leases).toMatchObject([{ deviceId: device.id }]);
    expect(eventsOf(harness, "lease.released")).toEqual([]);
  });

  it("the return reclaim holds a reclaim claim from before the absent → reclaiming write until it settles, and releases it when the reclaim throws", async () => {
    const held = await absentHarness("not-present");
    back(held.harness, "UDID-A");
    const writes = recordStateWrites(held.harness);
    const gate = holdNextReclaim(held.harness);
    startWatcher(held.harness);

    await tick(held.harness);
    expect(reclaimCalls(held.harness.driver)).toHaveLength(1);
    expect(held.harness.engine.core.claims.claim(held.device.id)?.kind).toBe("reclaim");
    expect(stateOf(held.harness, held.device)).toBe("reclaiming");
    expect(writes.find((write) => write.states[held.device.id] === "reclaiming")).toMatchObject({
      claims: { [held.device.id]: "reclaim" },
    });
    gate.resolve();
    await flush();
    expect(held.harness.engine.core.claims.isClaimed(held.device.id)).toBe(false);
    expect(stateOf(held.harness, held.device)).toBe("ready");

    const thrown = await absentHarness("not-present");
    back(thrown.harness, "UDID-A");
    thrown.harness.driver.failOn("reclaim", 1, new Error("usb dropped"));
    startWatcher(thrown.harness);

    await tick(thrown.harness);
    expect(reclaimCalls(thrown.harness.driver)).toHaveLength(1);
    expect(thrown.harness.engine.core.claims.isClaimed(thrown.device.id)).toBe(false);
  });

  it("an absent device read present while device add holds its claim gets no write and no reclaim that tick", async () => {
    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    const claim = harness.engine.core.claims.tryClaim(device.id, "enrollment");
    expect(claim).toBeDefined();
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness);
    expect(readsOf(harness.driver)).toEqual([["UDID-A"]]);
    expect(writes).toHaveLength(0);
    expect(reclaimCalls(harness.driver)).toHaveLength(0);
    expect(stateOf(harness, device)).toBe("absent");

    claim?.release();
    await tick(harness);
    expect(reclaimCalls(harness.driver)).toHaveLength(1);
  });

  it("an absent device read present is returned and reclaimed on that tick, at most one health.probeIntervalMs after it was scripted present", async () => {
    const { device, harness } = await absentHarness("not-present");
    startWatcher(harness);
    harness.clock.advance(10_000);
    await flush();

    back(harness, "UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();

    expect(eventsOf(harness, "device.returned")).toHaveLength(1);
    expect(reclaimCalls(harness.driver)).toHaveLength(1);
    expect(stateOf(harness, device)).toBe("ready");
  });

  it("a device the fake driver reports present again has a latest read of present within one health.probeIntervalMs", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-LATEST-WATCH");
    startWatcher(harness);
    gone(harness, "UDID-LATEST-WATCH", "locked");
    await tick(harness);
    expect(latestPresence("UDID-LATEST-WATCH")).toStrictEqual({ present: false, reason: "locked" });

    back(harness, "UDID-LATEST-WATCH");
    harness.clock.advance(PROBE_MS);
    await flush();

    expect(latestPresence("UDID-LATEST-WATCH")).toStrictEqual({ present: true });
  });

  it("two ready devices read not present for the grace period both become absent, each judged on its own state", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    gone(harness, "UDID-A", "locked");
    gone(harness, "UDID-B", "untrusted");
    startWatcher(harness);

    await tick(harness, 2);

    expect([stateOf(harness, first), stateOf(harness, second)]).toEqual(["absent", "absent"]);
    expect([absentReasonOf(harness, first), absentReasonOf(harness, second)]).toEqual([
      "locked",
      "untrusted",
    ]);
  });

  it("a tick where one device's action throws (its registry write fails) logs it, still acts on the other devices, and arms the next tick; that device's count is not reset, so the next not-present read acts on it again", async () => {
    const { logger, sink } = capturingLogger();
    const harness = await createHarness({ logger });
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    gone(harness, "UDID-A");
    gone(harness, "UDID-B");
    startWatcher(harness);
    await tick(harness);
    vi.spyOn(harness.state, "transaction").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const problems = () =>
      sink.records.filter((record) => record.level === "warn" || record.level === "error");
    const problemsBefore = problems().length;

    await tick(harness);
    const states = [stateOf(harness, first), stateOf(harness, second)];
    expect(states.filter((state) => state === "absent")).toHaveLength(1);
    expect(states.filter((state) => state === "ready")).toHaveLength(1);
    expect(problems().length).toBeGreaterThan(problemsBefore);
    const failed = [first, second].find((device) => stateOf(harness, device) === "ready");
    expect(
      problems().filter((record) => record.message === "physical device action failed"),
    ).toMatchObject([
      { fields: { deviceId: failed?.id, error: expect.anything() }, level: "warn" },
    ]);

    await tick(harness);
    expect(stateOf(harness, first)).toBe("absent");
    expect(stateOf(harness, second)).toBe("absent");
  });

  it("a ready device read not present once and then present wakes the queue: a physical request waiting for it is granted on that tick", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const waiting = harness.engine.request(physicalRequest, asking("agent"));
    expect(await outcome(waiting)).toBe("pending");
    startWatcher(harness);

    await tick(harness);
    expect(readsOf(harness.driver)).toContainEqual(["UDID-A"]);
    back(harness, "UDID-A");
    expect(await outcome(waiting)).toBe("pending");

    await tick(harness);
    expect(await outcome(waiting)).toMatchObject({ device: { id: device.id } });
  });

  it("a tick whose read resolves present after dispose does not wake the queue: a physical request waiting for the device stays pending", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    gone(harness, "UDID-A");
    const waiting = harness.engine.request(physicalRequest, asking("agent"));
    expect(await outcome(waiting)).toBe("pending");
    startWatcher(harness);
    await tick(harness);
    back(harness, "UDID-A");
    harness.driver.holdPresenceReads("UDID-A");
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(3);

    watcherOf(harness)?.dispose();
    harness.driver.releasePresenceReads();

    expect(await outcome(waiting)).toBe("pending");
  });

  it("a tick whose read resolves after dispose writes nothing and starts no reclaim, and leasing.settle() resolves only after that tick", async () => {
    const ready = await createHarness();
    const readyDevice = await enrollIphone(ready, "UDID-A");
    gone(ready, "UDID-A");
    startWatcher(ready);
    await tick(ready);
    const readyWrites = recordStateWrites(ready);
    ready.driver.holdPresenceReads("UDID-A");
    ready.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(ready.driver)).toHaveLength(2);

    watcherOf(ready)?.dispose();
    const settling = ready.engine.leasing.settle();
    expect(await isSettled(settling)).toBe(false);
    ready.driver.releasePresenceReads();
    expect(await isSettled(settling)).toBe(true);
    expect(stateOf(ready, readyDevice)).toBe("ready");
    expect(readyWrites).toHaveLength(0);

    const { device, harness } = await absentHarness("not-present");
    back(harness, "UDID-A");
    const writes = recordStateWrites(harness);
    harness.driver.holdPresenceReads("UDID-A");
    startWatcher(harness);
    harness.clock.advance(PROBE_MS);
    await flush();
    expect(readsOf(harness.driver)).toHaveLength(1);

    watcherOf(harness)?.dispose();
    harness.driver.releasePresenceReads();
    await flush();
    expect(stateOf(harness, device)).toBe("absent");
    expect(writes).toHaveLength(0);
    expect(reclaimCalls(harness.driver)).toHaveLength(0);
  });

  it("a platform with no driver changes no count and no state, and the other platform is still read", async () => {
    const harness = await createHarness();
    const iphone = await enrollIphone(harness, "UDID-A");
    const pixel = await harness.registry.enrollPhysical({
      apps: [],
      class: "phone",
      driverDeviceId: "EMU-1",
      model: "Pixel 8",
      osVersion: "14",
      platform: "android",
    });
    gone(harness, "UDID-A");
    startWatcher(harness);

    await tick(harness, 10);

    expect(stateOf(harness, iphone)).toBe("absent");
    expect(stateOf(harness, pixel)).toBe("ready");
    expect(readsOf(harness.driver)[0]).toEqual(["UDID-A"]);
  });

  it("a listing entry whose ID has no record causes no write and no driver call but the listing", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    const listing = vi.spyOn(harness.driver, "listPresentPhysical").mockResolvedValue(
      answer([
        { driverDeviceId: "UDID-A", osVersion: "18.4", present: true },
        { driverDeviceId: "UDID-GHOST-1", osVersion: "18.4", present: true },
        { driverDeviceId: "UDID-GHOST-2", present: false, reason: "locked" },
      ]),
    );
    const writes = recordStateWrites(harness);
    startWatcher(harness);

    await tick(harness, 3);

    expect(listing.mock.calls.length).toBeGreaterThan(0);
    expect(harness.driver.calls.map((call) => call.operation)).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it("a ready device that stays not present for health.stableObservations reads emits one device.absence-detected with previousState ready and the last read's reason", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    gone(harness, "UDID-A", "locked");

    await tick(harness, 2);

    expect(eventsOf(harness, "device.absence-detected")).toMatchObject([
      { payload: { absentReason: "locked", deviceId: device.id, previousState: "ready" } },
    ]);
  });

  it("a ready device read present without a miss does not wake the queue", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    const kick = vi.spyOn(
      harness.engine.leasing.corePorts.leaseMaintenance.acquisition as unknown as { kick(): void },
      "kick",
    );
    startWatcher(harness);

    await tick(harness, 2);

    expect(readsOf(harness.driver)).toHaveLength(2);
    expect(kick).not.toHaveBeenCalled();
  });

  it("a ready device read not present once and then present wakes the queue once, not again on the next present read", async () => {
    const harness = await createHarness();
    await enrollIphone(harness, "UDID-A");
    const kick = vi.spyOn(
      harness.engine.leasing.corePorts.leaseMaintenance.acquisition as unknown as { kick(): void },
      "kick",
    );
    startWatcher(harness);
    gone(harness, "UDID-A");
    await tick(harness);
    expect(kick).not.toHaveBeenCalled();

    back(harness, "UDID-A");
    await tick(harness);
    expect(kick).toHaveBeenCalledTimes(1);

    await tick(harness);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("a leased device read not present once and then present does not wake the queue", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    startWatcher(harness);
    await harness.engine.request(physicalRequest, asking("agent"));
    expect(stateOf(harness, device)).toBe("leased");
    const kick = vi.spyOn(
      harness.engine.leasing.corePorts.leaseMaintenance.acquisition as unknown as { kick(): void },
      "kick",
    );
    gone(harness, "UDID-A");
    await tick(harness);
    back(harness, "UDID-A");

    await tick(harness);

    expect(stateOf(harness, device)).toBe("leased");
    expect(kick).not.toHaveBeenCalled();
  });

  it("an absent device read present returns with the osVersion of the read, or with the one on its record when the read has none", async () => {
    const withVersion = await absentHarness("not-present");
    vi.spyOn(withVersion.harness.driver, "listPresentPhysical").mockResolvedValue(
      answer([{ driverDeviceId: "UDID-A", osVersion: "18.5", present: true }]),
    );
    startWatcher(withVersion.harness);
    await tick(withVersion.harness);
    expect(eventsOf(withVersion.harness, "device.returned")).toMatchObject([
      { payload: { deviceId: withVersion.device.id, osVersion: "18.5" } },
    ]);

    const withoutVersion = await absentHarness("not-present");
    vi.spyOn(withoutVersion.harness.driver, "listPresentPhysical").mockResolvedValue(
      answer([{ driverDeviceId: "UDID-A", present: true }]),
    );
    startWatcher(withoutVersion.harness);
    await tick(withoutVersion.harness);
    expect(eventsOf(withoutVersion.harness, "device.returned")).toMatchObject([
      { payload: { deviceId: withoutVersion.device.id, osVersion: "18.4" } },
    ]);
  });

  it("a tick whose watcher is disposed while it acts on one device acts on no later device of that tick", async () => {
    const options = { health: { stableObservations: 1 } };
    const first = await createHarness(options);
    const missing = await enrollIphone(first, "UDID-A");
    const returned = await enrollIphone(first, "UDID-B");
    const harness = await reopen(
      first,
      (database) => markAbsent(database, "UDID-B", "not-present"),
      options,
    );
    gone(harness, "UDID-A");
    back(harness, "UDID-B");
    const original = harness.state.transaction.bind(harness.state);
    vi.spyOn(harness.state, "transaction").mockImplementationOnce((work) => {
      watcherOf(harness)?.dispose();
      return original(work);
    });
    startWatcher(harness);

    await tick(harness);

    expect(stateOf(harness, missing)).toBe("absent");
    expect(stateOf(harness, returned)).toBe("absent");
    expect(reclaimCalls(harness.driver)).toEqual([]);
    expect(eventsOf(harness, "device.returned")).toEqual([]);
  });

  it("a tick whose watcher is disposed while it acts on one device does not wake the queue for a later device of that tick", async () => {
    const first = await createHarness();
    const missing = await enrollIphone(first, "UDID-A");
    const flickering = await enrollIphone(first, "UDID-B");
    gone(first, "UDID-A");
    gone(first, "UDID-B");
    const waiting = first.engine.request(physicalRequest, asking("agent"));
    expect(await outcome(waiting)).toBe("pending");
    startWatcher(first);
    await tick(first);
    back(first, "UDID-B");
    const original = first.state.transaction.bind(first.state);
    vi.spyOn(first.state, "transaction").mockImplementationOnce((work) => {
      watcherOf(first)?.dispose();
      return original(work);
    });

    await tick(first);

    expect(stateOf(first, missing)).toBe("absent");
    expect(stateOf(first, flickering)).toBe("ready");
    expect(await outcome(waiting)).toBe("pending");
  });
});

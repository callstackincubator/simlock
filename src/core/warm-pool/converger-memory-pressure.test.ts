import { describe, expect, it } from "vitest";
import { device, fakeMemoryPressure, harness, iphone15, minute, now } from "./test-fixtures.js";

describe("warm pool memory pressure", () => {
  const paused = (readingAt: number) => ({
    cause: { availablePercent: 12, level: "warn" as const, trigger: "level" as const },
    readingAt,
    since: now,
    step: "warming-paused" as const,
  });

  it("each reading while warming is paused shuts down one idle device", async () => {
    const pressure = fakeMemoryPressure(paused(now));
    const rig = harness(
      [
        device("old", "ready", 90 * minute),
        device("mid", "ready", 60 * minute),
        device("new", "ready", 5 * minute),
      ],
      { memoryPressure: pressure.reader },
    );
    rig.pool.start();

    pressure.reading(paused(now + 15_000));
    await rig.pool.settle();
    expect(rig.shutdownCalls).toEqual(["old"]);

    pressure.reading(paused(now + 30_000));
    await rig.pool.settle();
    expect(rig.shutdownCalls).toEqual(["old", "mid"]);

    await rig.pool.pass();
    expect(rig.shutdownCalls, "a second pass on the same reading").toEqual(["old", "mid"]);
  });

  it("sheds nothing for a reading before start, at step none, with no step reading or nothing idle, and skips a device whose shutdown just failed", async () => {
    const idle = () => [device("old", "ready", 90 * minute), device("mid", "ready", 60 * minute)];
    const none = { ...paused(now), step: "none" as const };
    const cases = [
      { name: "before start", reading: paused(now + 15_000), start: false },
      { name: "step none", reading: none },
      { name: "no step reading", reading: undefined },
      {
        devices: [device("old", "leased", 90 * minute)],
        name: "nothing idle",
        reading: paused(now + 15_000),
      },
    ];
    for (const { devices = idle(), name, reading, start = true } of cases) {
      const pressure = fakeMemoryPressure(reading);
      const rig = harness(devices, { memoryPressure: pressure.reader });
      if (start) rig.pool.start();
      pressure.reading(reading === undefined ? undefined : { ...reading, readingAt: now + 15_000 });
      await rig.pool.settle();
      expect(rig.shutdownCalls, name).toEqual([]);
    }

    const pressure = fakeMemoryPressure(paused(now));
    const failing = harness(idle(), {
      memoryPressure: pressure.reader,
      shutdown: async (target) => {
        if (target.id === "old") throw new Error("the simulator would not stop");
        return { ...target, state: "shutdown" };
      },
    });
    failing.pool.start();
    pressure.reading(paused(now + 15_000));
    await failing.pool.settle();
    pressure.reading(paused(now + 30_000));
    await failing.pool.settle();
    expect(failing.shutdownCalls, "the next reading takes the next device").toEqual(["old", "mid"]);
  });

  it("when warming resumes the pool fills its targets again on memory.pressure-changed, with no tick", async () => {
    const pressure = fakeMemoryPressure(paused(now));
    const rig = harness([], { memoryPressure: pressure.reader, targets: [iphone15] });
    rig.pool.start();
    await rig.pool.pass();
    await rig.pool.settle();
    expect(rig.provisionCalls, "nothing is created while paused").toEqual([]);

    pressure.reading({ readingAt: now + 15_000, step: "none" });
    rig.eventBus.emit(
      "memory.pressure-changed",
      { from: "warming-paused", to: "none" },
      "host-load",
    );
    await rig.pool.settle();

    expect(rig.provisionCalls).toHaveLength(1);
  });

  it("at warming-paused reports a short target memory-pressure, a target that does not resolve its own reason, and boots nothing", async () => {
    const rig = harness([device("shut", "shutdown", 1_000)], {
      memoryPressure: fakeMemoryPressure(paused(now)).reader,
      resolve: (request) =>
        request.model === "iPhone 17"
          ? { message: "iOS 27.0 is not installed", refusal: "runtime-missing" }
          : { spec: { model: "iPhone 15", osVersion: "26.0", physical: false, platform: "ios" } },
      targets: [iphone15, { ...iphone15, model: "iPhone 17", osVersion: "27.0" }],
    });
    const reasons: Record<string, string> = {};
    rig.eventBus.subscribe("warm-pool.target-missed", ({ payload }) => {
      reasons[payload.model] = payload.reason;
    });

    await rig.pool.pass();
    await rig.pool.settle();

    expect(reasons).toEqual({ "iPhone 15": "memory-pressure", "iPhone 17": "runtime-missing" });
    expect(
      Object.fromEntries(rig.pool.figures().targets.map((target) => [target.model, target.short])),
    ).toEqual({ "iPhone 15": "memory-pressure", "iPhone 17": "runtime-missing" });
    expect(rig.bootCalls).toEqual([]);
    expect(rig.provisionCalls).toEqual([]);
  });
});

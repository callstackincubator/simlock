import { describe, expect, it } from "vitest";

import type { SeedSettleProgress } from "./index.js";
import {
  deferred,
  expectSettled,
  flush,
  iphoneSpec,
  minute,
  newDevicesPaused,
  none,
  quick,
  reserved,
  settledResult,
  settlerRig,
  warmingPaused,
} from "./test-rig.js";

const abortable = (signal: AbortSignal) =>
  new Promise<ReturnType<typeof settledResult>>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

describe("seed settler: memory pressure", () => {
  it("aborts a running settle at new-devices-paused and keeps its seed for later, goes on at warming-paused, and sends an operator's call back to waiting", async () => {
    const background = await settlerRig();
    background.ios.sources = [quick("seed", 3)];
    background.ios.settleSeed = (_id, signal) => abortable(signal);
    await background.started();
    await background.advance(5 * minute);
    background.pressure.reading(warmingPaused);
    await flush();
    expect(background.ios.settles[0]?.signal.aborted, "warming-paused: it goes on").toBe(false);
    background.pressure.reading(newDevicesPaused);
    await flush();
    expect(background.ios.settles[0]?.signal.aborted, "new-devices-paused: aborted").toBe(true);
    expect(reserved(background), "the reservation is released").toBe(0);
    expect(background.logs(), "an abort is no failure: no warning").toEqual([]);
    background.ios.settleSeed = async (sourceId) => settledResult(sourceId);
    background.pressure.reading(none);
    await background.advance(5 * minute);
    expectSettled(background, ["seed", "seed"], "chosen again at none, with no delay");

    const operator = await settlerRig();
    const progress: SeedSettleProgress[] = [];
    operator.ios.sources = [quick("seed", 3)];
    operator.ios.ensureSeed = async () => ({ leases: 3, settled: false, sourceId: "seed" });
    operator.ios.settleSeed = (_id, signal) => abortable(signal);
    await operator.started();
    const asked = operator.settler.settle(iphoneSpec, {
      onProgress: (next) => progress.push(next),
    });
    const outcome = asked.then(
      (result) => result,
      (error: unknown) => error,
    );
    await flush();
    expect(progress).toEqual([{ stage: "settling" }]);
    operator.pressure.reading(newDevicesPaused);
    await flush();
    expect(progress, "back to waiting").toEqual([
      { stage: "settling" },
      { reason: "memory-pressure", stage: "waiting" },
    ]);
    operator.ios.settleSeed = async (sourceId) => settledResult(sourceId);
    operator.pressure.reading(none);
    await flush();
    expect(await outcome).toMatchObject({ outcome: "settled", sourceId: "seed-settled" });

    const making = await settlerRig();
    const made = deferred<{ sourceId: string; settled: false; leases: number }>();
    const steps: SeedSettleProgress[] = [];
    making.ios.ensureSeed = () => made.promise;
    await making.started();
    const answered = making.settler.settle(iphoneSpec, { onProgress: (next) => steps.push(next) });
    await flush();
    making.pressure.reading(newDevicesPaused);
    made.resolve({ leases: 0, settled: false, sourceId: "made" });
    await flush();
    expectSettled(making, [], "the make finished, the settle waits");
    expect(steps).toEqual([{ stage: "making" }, { reason: "memory-pressure", stage: "waiting" }]);
    expect(reserved(making), "nothing is held while it waits").toBe(0);
    making.ios.settleSeed = (_id, signal) => abortable(signal);
    making.pressure.reading(none);
    await flush();
    expect(steps, "the make is not told again").toEqual([
      { stage: "making" },
      { reason: "memory-pressure", stage: "waiting" },
      { stage: "settling" },
    ]);
    making.pressure.reading(newDevicesPaused);
    await flush();
    expect(steps.at(-1), "a second wait for the same reason is told again").toEqual({
      reason: "memory-pressure",
      stage: "waiting",
    });
    making.ios.settleSeed = async (sourceId) => settledResult(sourceId);
    making.pressure.reading(none);
    await flush();
    await expect(answered).resolves.toMatchObject({ outcome: "settled", sourceId: "made-settled" });
  });
});

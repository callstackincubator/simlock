import { describe, expect, it } from "vitest";

import {
  deferred,
  expectSettled,
  flush,
  iphoneSpec,
  leaseReservation,
  minute,
  quick,
  settledResult,
  settlerRig,
} from "./test-rig.js";

describe("seed settler: one settle at a time", () => {
  it("runs one settle at a time on a worker, whatever else arrives (a second candidate, a lease's boot, an operator's call), and does not stop it for a lease that boots", async () => {
    const rig = await settlerRig();
    rig.ios.sources = [quick("first", 5), quick("second", 3)];
    rig.android.sources = [{ ...quick("android", 2), model: "Pixel 8", osVersion: "36" }];
    const running = deferred<ReturnType<typeof settledResult>>();
    rig.ios.settleSeed = () => running.promise;
    await rig.started();
    await rig.advance(5 * minute);
    expectSettled(rig, ["first"], "the most leased starts");

    const lease = leaseReservation(rig);
    await rig.advance(5 * minute);
    await rig.advance(5 * minute);
    expectSettled(rig, ["first"], "a second candidate on each platform waits");
    expect(rig.ios.settles[0]?.signal.aborted, "a lease's boot does not stop it").toBe(false);

    lease.release();
    rig.ios.sources = [quick("second", 3), quick("first-settled", 0, { settled: true })];
    running.resolve(settledResult("first"));
    rig.ios.settleSeed = async (sourceId) => {
      rig.ios.sources = rig.ios.sources.filter((source) => source.id !== sourceId);
      return settledResult(sourceId);
    };
    await flush();
    expectSettled(rig, ["first"], "nothing starts at its end: a boot ended a moment ago");
    await rig.advance(5 * minute);
    expectSettled(rig, ["first", "second"], "the next one, once the worker is quiet again");
    await rig.advance(5 * minute);
    expectSettled(rig, ["first", "second", "android"], "then the other platform's");

    const operator = await settlerRig();
    operator.ios.sources = [quick("first", 5)];
    const held = deferred<ReturnType<typeof settledResult>>();
    operator.ios.settleSeed = () => held.promise;
    await operator.started();
    await operator.advance(5 * minute);
    const progress: unknown[] = [];
    const joined = operator.settler.settle(iphoneSpec, {
      onProgress: (next) => progress.push(next),
    });
    const second = operator.settler.settle(iphoneSpec, { onProgress: () => undefined });
    await flush();
    expect(progress, "an operator's call waits for the running settle").toEqual([
      { reason: "settle-running", stage: "waiting" },
    ]);
    expectSettled(operator, ["first"], "and starts none beside it");
    held.resolve(settledResult("first"));
    await expect(joined, "it takes the running settle's answer").resolves.toMatchObject({
      outcome: "settled",
      sourceId: "first-settled",
    });
    await expect(second, "so does a second call for the kind").resolves.toMatchObject({
      outcome: "settled",
      sourceId: "first-settled",
    });
    expectSettled(operator, ["first"], "and no second settle starts");

    const twice = await settlerRig();
    const made = deferred<{ sourceId: string; settled: false; leases: number }>();
    twice.ios.ensureSeed = () => made.promise;
    await twice.started();
    const calls = [
      twice.settler.settle(iphoneSpec, { onProgress: () => undefined }),
      twice.settler.settle(iphoneSpec, { onProgress: () => undefined }),
    ];
    await flush();
    made.resolve({ leases: 0, settled: false, sourceId: "made" });
    await expect(Promise.all(calls), "two calls for one kind settle it once").resolves.toEqual([
      expect.objectContaining({ outcome: "settled", sourceId: "made-settled" }),
      expect.objectContaining({ outcome: "settled", sourceId: "made-settled" }),
    ]);
    expectSettled(twice, ["made"], "one settle");
  });
});

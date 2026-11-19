import { describe, expect, it } from "vitest";

import {
  deferred,
  expectSettled,
  flush,
  leaseReservation,
  minute,
  quick,
  settledResult,
  settlerRig,
} from "./test-rig.js";

describe("seed settler: one settle at a time", () => {
  it("runs one settle at a time on a worker, whatever else arrives, and does not stop it for a lease that boots", async () => {
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
  });
});

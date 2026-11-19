import { describe, expect, it } from "vitest";

import {
  deferred,
  expectSettled,
  flush,
  iphoneSpec,
  minute,
  quick,
  settledResult,
  settlerRig,
} from "./test-rig.js";

describe("seed settler: a failed settle", () => {
  it("logs a failed settle as a warning naming the kind and the message, and does not choose that seed in the background for an hour, though an operator's call settles it", async () => {
    const rig = await settlerRig();
    rig.ios.sources = [quick("broken", 5), quick("other", 2)];
    rig.ios.settleSeed = async (sourceId) => {
      if (sourceId === "broken") throw new Error("the simulator would not boot");
      rig.ios.sources = rig.ios.sources.filter((source) => source.id !== sourceId);
      return settledResult(sourceId);
    };
    await rig.started();
    await rig.advance(5 * minute);
    expectSettled(rig, ["broken"], "the failing seed first");
    const warning = rig.logs().find((record) => record.level === "warn");
    expect(warning?.fields, "the kind and the driver's message are logged").toMatchObject({
      message: "the simulator would not boot",
      model: "iPhone 17",
      osVersion: "26.5",
      platform: "ios",
    });

    await rig.advance(5 * minute);
    expectSettled(rig, ["broken", "other"], "within the hour another candidate is chosen");
    await rig.advance(50 * minute);
    expectSettled(rig, ["broken", "other"], "55 minutes after the failure, none");
    await rig.advance(4 * minute);
    await rig.advance(minute - 1);
    expectSettled(rig, ["broken", "other"], "59 min 59 s after the failure");
    await rig.advance(1);
    await rig.advance(minute);
    expectSettled(rig, ["broken", "other", "broken"], "after the hour it is chosen again");

    const operator = await settlerRig();
    operator.ios.sources = [quick("broken", 5)];
    const failing = deferred<never>();
    operator.ios.settleSeed = () => failing.promise;
    await operator.started();
    await operator.advance(5 * minute);
    failing.reject(new Error("the simulator would not boot"));
    await flush();
    operator.ios.settleSeed = async (sourceId) => settledResult(sourceId);
    operator.ios.ensureSeed = async () => ({ leases: 5, settled: false, sourceId: "broken" });
    await expect(
      operator.settler.settle(iphoneSpec, { onProgress: () => undefined }),
    ).resolves.toMatchObject({ outcome: "settled", sourceId: "broken-settled" });
    expectSettled(operator, ["broken", "broken"], "the operator's call settles it");
  });
});

import { describe, expect, it } from "vitest";

import { type DriverSource } from "../driver.js";
import { NukeService } from "../nuke-service.js";
import {
  deferred,
  expectSettled,
  flush,
  iphoneSpec,
  minute,
  quick,
  settledResult,
  settlerRig,
  type SettlerRig,
} from "./test-rig.js";

/** why: a nuke whose lease and acquisition steps are fakes and whose seeds are the rig's iOS sources. */
function nukeOf(rig: SettlerRig, order: string[]) {
  const held = deferred<void>();
  return {
    finish: () => held.resolve(),
    service: new NukeService({
      acquisition: {
        beginMaintenance: async () => void order.push("nuke began"),
        endMaintenance: async () => {
          await held.promise;
          order.push("nuke ended");
        },
      },
      baselines: { removeAll: async () => ({ names: [] }) },
      devices: { destroy: async () => undefined, shutdown: async () => undefined },
      drivers: [
        {
          destroySource: async (sourceId) => {
            order.push(`seed ${sourceId} deleted`);
            rig.ios.sources = rig.ios.sources.filter((source) => source.id !== sourceId);
          },
          listSources: async () => rig.ios.sources,
          platform: "ios",
        },
      ],
      leases: {
        beginMaintenance: async () => undefined,
        endMaintenance: async () => undefined,
        releaseAllDuringMaintenance: async () => [],
      },
      registry: { snapshot: { leases: [], virtualDevices: [] } },
      seedSettler: rig.settler,
      warmPool: { forget: () => undefined },
    }),
  };
}

describe("seed settler: nuke", () => {
  it("is held by a nuke: a running settle is aborted and awaited before nuke deletes seeds, none starts during it, and checks resume after it, and none starts for a check that was under way when it began", async () => {
    const rig = await settlerRig();
    rig.ios.sources = [quick("seed", 3)];
    const order: string[] = [];
    const returned = deferred<void>();
    rig.ios.settleSeed = (_id, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            order.push("settle aborted");
            void returned.promise.then(() => {
              order.push("settle returned");
              reject(signal.reason);
            });
          },
          { once: true },
        );
      });
    await rig.started();
    await rig.advance(5 * minute);
    expect(rig.ios.settles, "a settle is running").toHaveLength(1);

    const nuke = nukeOf(rig, order);
    const nuked = nuke.service.nuke(true);
    await flush();
    expect(order, "the nuke waits for the settle").toEqual(["settle aborted"]);
    returned.resolve();
    await flush();
    expect(order, "the settle ended before the nuke began").toEqual([
      "settle aborted",
      "settle returned",
      "nuke began",
      "seed seed deleted",
    ]);
    expect(rig.ios.sources, "no seed is left or made after the nuke deleted them").toEqual([]);

    rig.ios.sources = [quick("another", 4)];
    rig.ios.settleSeed = async (sourceId) => settledResult(sourceId);
    await rig.advance(10 * minute);
    expectSettled(rig, ["seed"], "no settle starts while the nuke holds the settler");
    const asked = rig.settler.settle(iphoneSpec, { onProgress: () => undefined });
    rig.ios.ensureSeed = async () => ({ leases: 4, settled: false, sourceId: "another" });
    await flush();
    expectSettled(rig, ["seed"], "an operator's call waits");

    nuke.finish();
    await nuked;
    await flush();
    await expect(asked, "then the operator's call goes on").resolves.toMatchObject({
      outcome: "settled",
      sourceId: "another-settled",
    });
    expectSettled(rig, ["seed", "another"], "checks resume");

    const racing = await settlerRig();
    const listing = deferred<DriverSource[]>();
    racing.ios.listSources = () => listing.promise;
    await racing.started();
    await racing.advance(5 * minute);
    const raced = nukeOf(racing, []);
    const racedNuke = raced.service.nuke(false);
    await flush();
    listing.resolve([quick("seed", 3)]);
    await flush();
    expectSettled(racing, [], "a nuke began while the check listed seeds");
    raced.finish();
    await racedNuke;

    const idle = await settlerRig();
    const quiet: string[] = [];
    const none = nukeOf(idle, quiet);
    none.finish();
    await none.service.nuke(false);
    expect(quiet, "a nuke with none running").toEqual(["nuke began", "nuke ended"]);
  });
});

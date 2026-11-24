import { describe, expect, it } from "vitest";

import { promiseState } from "../../test-support/promise-state.js";
import { avdDirectory } from "./testing.js";
import {
  imageProperties,
  letGo,
  seedWorld as world,
  sources,
  stepSettle,
  type SeedWorld,
} from "./test-seed-world.js";

describe("AndroidDriver seed turns", () => {
  it("makes a seed's deletion wait for the copies in flight, and a copy asked for after it began copy the kind's current seed", async () => {
    const stale = async (w: SeedWorld) => {
      await w.filesystem.writeFileAtomic(imageProperties, "Pkg.Revision=2\n");
      return w.driver.provision(w.spec);
    };
    const destroy = async (w: SeedWorld) => w.driver.destroySource("seed_two");
    const swap = async (w: SeedWorld) => {
      const settle = w.driver.settleSeed?.("seed_two", { signal: new AbortController().signal });
      if (settle === undefined) throw new Error("the driver offers no settleSeed");
      return settle;
    };
    /** why: a settle needs 3 simulated minutes of idle readings before it swaps; the others need none. */
    const drive = async (w: SeedWorld, name: string) => {
      await stepSettle(w, name === "a settle's swap" ? 100 : 0);
    };
    for (const [name, deletion] of [
      ["a stale seed's remake", stale],
      ["destroySource", destroy],
      ["a settle's swap", swap],
    ] as const) {
      const w = await world();
      const reached = w.filesystem.hold(`${sources}/seed_two/`);
      const copy = w.driver.provision(w.spec);
      await reached;

      const deleting = deletion(w);
      const deleted = promiseState(deleting);
      await drive(w, name);

      expect(deleted.state, `${name}: waits for the copy in flight`).toBe("pending");
      await expect(
        w.filesystem.exists(`${sources}/seed_two/simlock.avd`),
        `${name}: the seed's folder stays while a copy runs from it`,
      ).resolves.toBe(true);
      // why: a copy asked for after the deletion began is held at its own copy, so one that ignored the deletion would still be copying when the folder goes.
      const openFirst = w.filesystem.open;
      void w.filesystem.hold(`${sources}/seed_two/`);
      const after = w.driver.provision(w.spec);
      await letGo();
      openFirst();
      const device = await copy;
      await letGo();
      w.filesystem.open();
      await expect(
        w.filesystem.exists(`${avdDirectory}/${device.deviceId}/simlock.avd/config.ini`),
        `${name}: the copy in flight completed`,
      ).resolves.toBe(true);
      await deleting;
      const later = await after;
      await expect(
        w.filesystem.exists(`${avdDirectory}/${later.deviceId}/simlock.avd/config.ini`),
        `${name}: a copy asked for after the deletion began is a whole copy`,
      ).resolves.toBe(true);
      await expect(
        w.filesystem.exists(`${sources}/seed_two`),
        `${name}: the seed's folder is gone once its copies ended`,
      ).resolves.toBe(false);
    }
  });
});

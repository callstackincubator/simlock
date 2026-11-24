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

/** why: a removal's own steps take more ticks than one `letGo`, so a wait that is not held would still be running after one. */
async function letGoLong(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await letGo();
}

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

  it("makes the removal of a seed's image wait for the copy in flight, and a settle's own copy of a seed make its deletion wait", async () => {
    const removing = await world();
    const copying = removing.filesystem.hold(`${sources}/seed_two/`);
    const copy = removing.driver.provision(removing.spec);
    await copying;
    const target = (await removing.driver.listComponents()).find(
      (component) => component.variant === "google_apis/arm64-v8a",
    );
    const removal = removing.driver.removeComponent(target?.receipt ?? {}, {
      signal: new AbortController().signal,
    });
    const removed = promiseState(removal);
    await letGoLong();
    expect(removed.state, "removeComponent waits for the copy in flight").toBe("pending");
    await expect(
      removing.filesystem.exists(`${sources}/seed_two/simlock.avd`),
      "the seed's folder stays while a copy runs from it",
    ).resolves.toBe(true);
    removing.filesystem.open();
    const device = await copy;
    await removal;
    await expect(
      removing.filesystem.exists(`${avdDirectory}/${device.deviceId}/simlock.avd/config.ini`),
      "the copy in flight completed",
    ).resolves.toBe(true);
    await expect(removing.filesystem.exists(`${sources}/seed_two`)).resolves.toBe(false);

    const settling = await world();
    const reached = settling.filesystem.hold(`${sources}/seed_two/`);
    const settle = settling.driver.settleSeed?.("seed_two", {
      signal: new AbortController().signal,
    });
    if (settle === undefined) throw new Error("the driver offers no settleSeed");
    const ended = settle.catch((error: unknown) => error);
    await reached;
    const deleting = settling.driver.destroySource("seed_two");
    const deleted = promiseState(deleting);
    await letGoLong();
    expect(deleted.state, "a deletion waits for the settle's copy of the seed").toBe("pending");
    await expect(
      settling.filesystem.exists(`${sources}/seed_two/simlock.avd`),
      "the seed's folder stays while the settle copies it",
    ).resolves.toBe(true);
    settling.filesystem.open();
    await deleting;
    await expect(
      settling.filesystem.exists(`${sources}/seed_three/simlock.avd/config.ini`),
      "the settle's copy is whole",
    ).resolves.toBe(true);
    await stepSettle(settling, 100);
    await ended;
  });

  it("runs two deletions of one seed at once one after the other", async () => {
    const w = await world();

    await Promise.all([w.driver.destroySource("seed_two"), w.driver.destroySource("seed_two")]);

    expect(w.filesystem.mostRemovingAtOnce, "the second deletion began while the first ran").toBe(
      1,
    );
    await expect(w.filesystem.exists(`${sources}/seed_two`)).resolves.toBe(false);
  });
});

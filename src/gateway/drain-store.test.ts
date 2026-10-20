import { describe, expect, it } from "vitest";

import { openMemoryStateDatabase } from "../auth/testing.js";
import { drainedWorkersOwner, StateDrainStore } from "./drain-store.js";

async function drainStore() {
  const { database } = await openMemoryStateDatabase([drainedWorkersOwner]);
  return { database, store: new StateDrainStore({ database }) };
}

describe("StateDrainStore", () => {
  it("save then load returns the same ids in the order saved, a later save replaces the set, and a fresh database loads none", async () => {
    const { store } = await drainStore();
    await expect(store.load()).resolves.toEqual([]);

    await store.save(["wrk_b", "wrk_a"]);
    await expect(store.load()).resolves.toEqual(["wrk_b", "wrk_a"]);

    await store.save(["wrk_c"]);
    await expect(store.load()).resolves.toEqual(["wrk_c"]);

    await store.save([]);
    await expect(store.load()).resolves.toEqual([]);
  });

  it("a save whose statement throws resolves, and a load that throws answers none", async () => {
    const { database, store } = await drainStore();
    await store.save(["wrk_a"]);
    database.exec("DROP TABLE drained_workers");

    await expect(store.save(["wrk_b"])).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual([]);
  });
});

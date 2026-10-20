import { describe, expect, it } from "vitest";

import { openMemoryStateDatabase } from "../auth/testing.js";
import type { Logger } from "../ports/index.js";
import { drainedWorkersOwner, StateDrainStore } from "./drain-store.js";

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
    child: () => logger,
  };
  return { errors, logger };
}

async function drainStore(logger?: Logger) {
  const { database } = await openMemoryStateDatabase([drainedWorkersOwner]);
  return { database, store: new StateDrainStore({ database, ...(logger ? { logger } : {}) }) };
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

  it("a save whose statement throws resolves, and a load that throws answers none, each logged", async () => {
    const { errors, logger } = recordingLogger();
    const { database, store } = await drainStore(logger);
    await store.save(["wrk_a"]);
    database.exec("DROP TABLE drained_workers");

    await expect(store.save(["wrk_b"])).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual([]);
    expect(errors).toEqual([
      "Could not persist the gateway's worker registry",
      "Could not read the gateway's worker registry; drains are forgotten",
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { openMemoryStateDatabase } from "../auth/testing.js";
import { FakeClock, type Logger } from "../ports/index.js";
import { endedLeaseIdsOwner, MemoryEndedLeaseIds, StateEndedLeaseIds } from "./ended-lease-ids.js";

const RETENTION_MS = 10_000;

class RecordingLogger implements Logger {
  readonly errors: string[] = [];
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(message: string): void {
    this.errors.push(message);
  }
  child(): Logger {
    return this;
  }
}

async function store() {
  const clock = new FakeClock(100_000);
  const logger = new RecordingLogger();
  const { database } = await openMemoryStateDatabase([endedLeaseIdsOwner]);
  return {
    clock,
    database,
    logger,
    store: new StateEndedLeaseIds({ clock, database, logger, retentionMs: RETENTION_MS }),
  };
}

// why: a part of a decomposed module: the store is a gateway-internal file behind the coordinator, and its failing statements and pruning are not reachable through the surface.
describe("ended lease ids", () => {
  it.each([
    ["state.db", async () => (await store()).store],
    [
      "memory",
      async () =>
        new MemoryEndedLeaseIds({ clock: new FakeClock(100_000), retentionMs: RETENTION_MS }),
    ],
  ])(
    "%s: an id answers when it ended while inside the retention window and none otherwise",
    async (_name, make) => {
      const ids = await make();

      ids.record("myid", 95_000);

      expect(ids.endedAt("myid")).toBe(95_000);
      expect(ids.endedAt("other")).toBeUndefined();
    },
  );

  it("state.db: an id past the retention window answers none, and the next record prunes its row", async () => {
    const { clock, database, store: ids } = await store();
    ids.record("old", 100_000);
    clock.advance(RETENTION_MS + 1);

    expect(ids.endedAt("old")).toBeUndefined();
    ids.record("new", clock.now());

    expect(database.prepare("SELECT lease_id FROM ended_lease_ids").all()).toEqual([
      { lease_id: "new" },
    ]);
  });

  it("state.db: a record or a read whose statement throws is logged and the gateway goes on", async () => {
    const { database, logger, store: ids } = await store();
    ids.record("myid", 95_000);
    database.exec("DROP TABLE ended_lease_ids");

    expect(() => ids.record("again", 96_000)).not.toThrow();
    expect(logger.errors).toEqual(["Could not record the gateway's ended lease ids"]);
    expect(ids.endedAt("myid")).toBeUndefined();
    expect(logger.errors).toEqual([
      "Could not record the gateway's ended lease ids",
      "Could not read the gateway's ended lease ids",
    ]);
  });
});

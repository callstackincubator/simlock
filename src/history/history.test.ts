import { rm, stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteOpener } from "../ports/index.js";
import { plainProjection, ProbeSqliteOpener } from "./testing.js";
import {
  NOW,
  directories,
  rig,
  stopping,
  relayed,
  levelRecords,
  recordingProjection,
  damagedNames,
  countRows,
  INSERTS_EVENT,
} from "./test-history.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("createEventHistory", () => {
  // why: Windows has no owner-only file mode.
  it.skipIf(process.platform === "win32")(
    "creates history.db and its -wal and -shm files owner-only, mode 0o600",
    async () => {
      // why: #685 made the event store owner-only; a 022 umask would hide a 0644 default.
      const previousUmask = process.umask(0o022);
      try {
        const rigged = await rig();
        const history = rigged.history();
        await history.start();
        stopping(rigged.bus, "mode");
        await history.replay({ sinceTs: 0 });
        const modes = Object.fromEntries(
          await Promise.all(
            ["", "-wal", "-shm"].map(
              async (suffix) =>
                [`history.db${suffix}`, (await stat(rigged.dbPath + suffix)).mode & 0o777] as const,
            ),
          ),
        );
        await history.stop();
        expect(modes).toEqual({
          "history.db": 0o600,
          "history.db-shm": 0o600,
          "history.db-wal": 0o600,
        });
      } finally {
        process.umask(previousUmask);
      }
    },
  );

  it("writes every emitted and every republished event as one row equal to its envelope, read back in timestamp, then seq order", async () => {
    const rigged = await rig({ capacity: 2 });
    const history = rigged.history();
    await history.start();

    const first = stopping(rigged.bus, "line\nbreak é 日本");
    rigged.clock.advance(1_000);
    const second = rigged.bus.emit(
      "lease.expired",
      { deviceId: "d-1", leaseId: "l-1", ownerId: "o-1" },
      "leases",
    );
    const early = relayed(rigged.bus, "evt_early", NOW + 500);
    const tiedFirst = relayed(rigged.bus, "evt_tie_a", NOW + 1_000);
    const tiedSecond = relayed(rigged.bus, "evt_tie_b", NOW + 1_000);

    const replayed = await history.replay({ sinceTs: 0 });
    await history.stop();
    expect(rigged.bus.replay()).toHaveLength(2);
    expect(replayed).toEqual([first, early, second, tiedFirst, tiedSecond]);
  });

  it("reads events sharing one timestamp in seq order, not in the order their rows were written", async () => {
    const earlierRun = await rig();
    const earlierWriter = earlierRun.history();
    await earlierWriter.start();
    relayed(earlierRun.bus, "evt_pad", NOW - 1);
    const highSeq = relayed(earlierRun.bus, "evt_high", NOW);
    await earlierWriter.stop();
    const laterRun = await rig({ directory: earlierRun.directory });
    const laterWriter = laterRun.history();
    await laterWriter.start();
    const lowSeq = relayed(laterRun.bus, "evt_low", NOW);

    const replayed = await laterWriter.replay({ sinceTs: NOW - 1 });
    await laterWriter.stop();
    expect([highSeq.seq, lowSeq.seq]).toEqual([2, 1]);
    expect(replayed).toEqual([lowSeq, highSeq]);
  });

  it("answers replay({ sinceTs }) with the events strictly newer than sinceTs", async () => {
    const rigged = await rig({ capacity: 1 });
    const history = rigged.history();
    await history.start();
    const older = stopping(rigged.bus, "older");
    rigged.clock.advance(10);
    const newer = stopping(rigged.bus, "newer");
    rigged.clock.advance(10);
    const newest = stopping(rigged.bus, "newest");

    const replayed = await history.replay({ sinceTs: older.timestamp });
    await history.stop();
    expect(replayed).toEqual([newer, newest]);
  });

  it("replayPage with beforeId and limit returns the limit events just older than the named one, oldest first, and stops short at the start of the history", async () => {
    const rigged = await rig();
    const history = rigged.history();
    await history.start();
    const rows = [1, 2, 3, 4, 5].map((n) => relayed(rigged.bus, `evt_row${n}`, NOW + n));

    const middle = await history.replayPage({ beforeId: "evt_row4", limit: 2 });
    const start = await history.replayPage({ beforeId: "evt_row2", limit: 5 });
    await history.stop();

    const failing = await rig();
    const sqlite = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "prepare" && /rowid\) </.test(call.sql)) throw new Error("read failed");
      },
    });
    const throwing = failing.history({ sqlite });
    await throwing.start();
    relayed(failing.bus, "evt_one", NOW + 1);
    relayed(failing.bus, "evt_two", NOW + 2);
    const fromThrowing = await throwing.replayPage({ beforeId: "evt_two", limit: 5 });
    await throwing.stop();

    expect(middle).toEqual({ events: [rows[1], rows[2]], kind: "events" });
    expect(start).toEqual({ events: [rows[0]], kind: "events" });
    expect(fromThrowing).toEqual({ kind: "unavailable" });
    expect(levelRecords(failing, "warn")).toBe(1);
  });

  it("replayPage pages two events with the same timestamp and seq from different runs in row order, each once", async () => {
    const earlierRun = await rig();
    const earlierWriter = earlierRun.history();
    await earlierWriter.start();
    const first = relayed(earlierRun.bus, "evt_tie_z", NOW);
    await earlierWriter.stop();
    const laterRun = await rig({ directory: earlierRun.directory });
    const laterWriter = laterRun.history();
    await laterWriter.start();
    const second = relayed(laterRun.bus, "evt_tie_a", NOW);
    relayed(laterRun.bus, "evt_tie_last", NOW + 1);

    const newest = await laterWriter.replayPage({ beforeId: "evt_tie_last", limit: 1 });
    const older = await laterWriter.replayPage({ beforeId: "evt_tie_a", limit: 1 });
    await laterWriter.stop();
    expect(first.seq).toBe(second.seq);
    expect([newest, older]).toEqual([
      { events: [second], kind: "events" },
      { events: [first], kind: "events" },
    ]);
  });

  it("a second insert of an event with an id already stored adds no row and runs no projection step", async () => {
    const rigged = await rig();
    const projection = recordingProjection();
    const history = rigged.history({ projections: [projection.definition] });
    await history.start();

    const original = relayed(rigged.bus, "evt_twice", NOW);
    relayed(rigged.bus, "evt_twice", NOW + 5);
    const other = relayed(rigged.bus, "evt_other", NOW + 6);

    const replayed = await history.replay({ sinceTs: 0 });
    await history.stop();
    expect(replayed).toEqual([original, other]);
    expect(projection.applied).toEqual(["evt_twice", "evt_other"]);
  });

  it("a projection that throws leaves neither its rows nor the event row, and stops writing", async () => {
    const rigged = await rig();
    const applied: string[] = [];
    const definition = plainProjection("throwing", (database) => {
      database.exec("CREATE TABLE IF NOT EXISTS projected (id TEXT PRIMARY KEY)");
      const insert = database.prepare("INSERT INTO projected (id) VALUES (?)");
      return {
        apply: (envelope) => {
          insert.run(envelope.id);
          applied.push(envelope.id);
          if ((envelope.payload as { reason?: string }).reason === "boom") {
            throw new Error("projection failed");
          }
        },
        prune: () => undefined,
      };
    });
    const history = rigged.history({ projections: [definition] });
    await history.start();

    const before = stopping(rigged.bus, "fine");
    stopping(rigged.bus, "boom");
    stopping(rigged.bus, "after");

    const replayed = await history.replay({ sinceTs: 0 });
    const status = history.status();
    await history.stop();
    expect(replayed).toEqual([before]);
    expect(status.writing).toBe(false);
    expect(applied).toHaveLength(2);
    expect(await countRows(rigged.dbPath, "projected")).toBe(1);
    expect(levelRecords(rigged, "error")).toBe(1);
  });

  it("a write that throws logs one error, sets writing false, and later events still reach the ring and other subscribers", async () => {
    const rigged = await rig({ capacity: 2 });
    const sqlite = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "prepare" && INSERTS_EVENT.test(call.sql)) {
          throw new Error("disk full");
        }
      },
    });
    const history = rigged.history({ sqlite });
    await history.start();
    const delivered: string[] = [];
    rigged.bus.subscribeAll((entry) => delivered.push(entry.id));

    const first = stopping(rigged.bus, "a");
    const second = stopping(rigged.bus, "b");

    expect(history.status().writing).toBe(false);
    expect(levelRecords(rigged, "error")).toBe(1);
    expect(delivered).toEqual([first.id, second.id]);
    expect(rigged.bus.replay()).toEqual([first, second]);
    await history.stop();
  });

  it("an event JSON.stringify cannot serialize is dropped with one logged error, and the next event is still written", async () => {
    const rigged = await rig({ capacity: 4 });
    const history = rigged.history();
    await history.start();
    const depth = 20_000;
    const nested = JSON.parse("[".repeat(depth) + "]".repeat(depth)) as unknown;

    rigged.bus.republish({
      event: "daemon.stopping",
      id: "evt_nested",
      module: "daemon",
      payload: { nested, reason: "nested" } as never,
      timestamp: NOW,
    });
    stopping(rigged.bus, "after");

    expect(history.status().writing).toBe(true);
    expect(levelRecords(rigged, "error")).toBe(1);
    expect(await countRows(rigged.dbPath, "events")).toBe(1);
    await history.stop();
  });

  it("replays the ring without sinceTs", async () => {
    const rigged = await rig({ capacity: 2 });
    const history = rigged.history();
    await history.start();
    stopping(rigged.bus, "one");
    const two = stopping(rigged.bus, "two");
    const three = stopping(rigged.bus, "three");

    const replayed = await history.replay();
    await history.stop();
    expect(replayed).toEqual([two, three]);
    expect(levelRecords(rigged, "warn")).toBe(0);
  });

  it("replays the ring with sinceTs before start() opened the file", async () => {
    const rigged = await rig({ capacity: 2 });
    const history = rigged.history();
    stopping(rigged.bus, "one");
    const two = stopping(rigged.bus, "two");
    const three = stopping(rigged.bus, "three");

    expect(await history.replay({ sinceTs: 0 })).toEqual([two, three]);
  });

  it("replays the ring with sinceTs once writing has stopped", async () => {
    const rigged = await rig({ capacity: 2 });
    let writes = 0;
    const sqlite = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "prepare" && INSERTS_EVENT.test(call.sql)) {
          if (writes === 2) throw new Error("disk full");
          writes += 1;
        }
      },
    });
    const history = rigged.history({ sqlite });
    await history.start();
    stopping(rigged.bus, "one");
    stopping(rigged.bus, "two");
    const three = stopping(rigged.bus, "three");
    const four = stopping(rigged.bus, "four");

    expect(history.status().writing).toBe(false);
    expect(await history.replay({ sinceTs: 0 })).toEqual([three, four]);
    await history.stop();
  });

  it("replays the ring with sinceTs, and logs one warning, when the read throws", async () => {
    const rigged = await rig({ capacity: 2 });
    const sqlite = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "prepare" && /timestamp\s*>\s*\?/i.test(call.sql)) {
          throw new Error("read failed");
        }
      },
    });
    const history = rigged.history({ sqlite });
    await history.start();
    stopping(rigged.bus, "one");
    const two = stopping(rigged.bus, "two");
    const three = stopping(rigged.bus, "three");

    expect(await history.replay({ sinceTs: 0 })).toEqual([two, three]);
    expect(levelRecords(rigged, "warn")).toBe(1);
    expect(history.status().writing).toBe(true);
    await history.stop();
  });

  it("replayPage with limit alone returns the newest n, oldest first, and the newest n held in memory when the history is unreadable or its read throws", async () => {
    const served = await rig({ capacity: 3 });
    const history = served.history();
    await history.start();
    const rows = [1, 2, 3, 4].map((n) => relayed(served.bus, `evt_row${n}`, NOW + n));
    const fromFile = await history.replayPage({ limit: 3 });
    await history.stop();

    const unread = await rig({ capacity: 3 });
    const unreadable = [1, 2, 3].map((n) => relayed(unread.bus, `evt_row${n}`, NOW + n));
    const fromUnstarted = await unread.history().replayPage({ limit: 2 });

    const failing = await rig({ capacity: 2 });
    const sqlite = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "prepare" && /DESC/i.test(call.sql)) throw new Error("read failed");
      },
    });
    const throwing = failing.history({ sqlite });
    await throwing.start();
    relayed(failing.bus, "evt_one", NOW + 1);
    const held = [2, 3].map((n) => relayed(failing.bus, `evt_held${n}`, NOW + n));
    const fromThrowing = await throwing.replayPage({ limit: 5 });
    await throwing.stop();

    const halted = await rig();
    const definition = plainProjection("halting", () => ({
      apply: (envelope) => {
        if ((envelope.payload as { reason?: string }).reason === "boom") {
          throw new Error("projection failed");
        }
      },
      prune: () => undefined,
    }));
    const stopped = halted.history({ projections: [definition] });
    await stopped.start();
    const stoppedHeld = ["fine", "boom", "after"].map((reason) => stopping(halted.bus, reason));
    const fromStopped = await stopped.replayPage({ limit: 5 });
    await stopped.stop();

    expect(fromFile).toEqual({ events: rows.slice(1), kind: "events" });
    expect(fromUnstarted).toEqual({ events: unreadable.slice(1), kind: "events" });
    expect(fromThrowing).toEqual({ events: held, kind: "events" });
    expect(levelRecords(failing, "warn")).toBe(1);
    expect(fromStopped).toEqual({ events: stoppedHeld, kind: "events" });
  });

  it("reads a worker's events without the database or the index: from memory with limit counted after the filter, past a failed index build that sets nothing aside, and past a stored row of bad JSON", async () => {
    const memory = await rig({ capacity: 10 });
    const connected = (workerId: string) =>
      memory.bus.emit("worker.connected", { workerId }, "gateway");
    const first = connected("w1");
    const rejected = memory.bus.emit(
      "worker.rejected",
      { reason: "forbidden", workerId: "w1" },
      "gateway",
    );
    connected("w2");
    connected("w2");
    const unstarted = memory.history();
    const newestOfW1 = await unstarted.replayPage({ limit: 2, workerId: "w1" });
    const recent = await unstarted.replay({ workerId: "w1" });

    const unindexed = await rig();
    const noIndex = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "exec" && /CREATE INDEX.*events_worker/is.test(call.sql)) {
          throw new Error("disk full");
        }
      },
    });
    const scanning = unindexed.history({ sqlite: noIndex });
    await scanning.start();
    const written = unindexed.bus.emit("worker.connected", { workerId: "w1" }, "gateway");
    unindexed.bus.emit("worker.connected", { workerId: "w2" }, "gateway");
    const scanned = await scanning.replayPage({ limit: 5, workerId: "w1" });
    const scanningStatus = scanning.status();
    await scanning.stop();

    const damaged = await rig();
    const seeded = damaged.history();
    await seeded.start();
    const good = damaged.bus.emit("worker.connected", { workerId: "w1" }, "gateway");
    await seeded.stop();
    const file = await new NodeSqliteOpener().open(damaged.dbPath, { readOnly: false });
    file.exec("DROP INDEX events_worker");
    file
      .prepare("INSERT INTO events (id, timestamp, seq, size, envelope) VALUES (?, ?, ?, ?, ?)")
      .run("evt_bad", NOW, 99, 5, "{nope");
    file.close();
    const reopened = damaged.history();
    await reopened.start();
    const afterBadRow = await reopened.replayPage({ limit: 5, workerId: "w1" });
    const reopenedStatus = reopened.status();
    await reopened.stop();
    const indexes = await new NodeSqliteOpener().open(damaged.dbPath, { readOnly: true });
    const indexed = indexes
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_worker'")
      .all();
    indexes.close();

    expect(newestOfW1).toEqual({ events: [first], kind: "events" });
    expect(recent).toEqual([first]);
    expect(rejected.payload).toMatchObject({ workerId: "w1" });
    expect(levelRecords(unindexed, "warn")).toBe(1);
    expect(unindexed.logs.records.find((record) => record.level === "warn")?.fields).toMatchObject({
      error: "disk full",
    });
    expect(await damagedNames(unindexed.directory)).toEqual([]);
    expect(scanningStatus).toMatchObject({ opened: true, writing: true });
    expect(scanned).toEqual({ events: [written], kind: "events" });
    expect(levelRecords(damaged, "warn")).toBe(0);
    expect(reopenedStatus).toMatchObject({ opened: true, writing: true });
    expect(indexed).toEqual([{ name: "events_worker" }]);
    expect(afterBadRow).toEqual({ events: [good], kind: "events" });
  });
});

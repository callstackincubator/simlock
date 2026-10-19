import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  MemoryLogSink,
  NodeFilesystem,
  NodeSqliteOpener,
  SqliteUnavailableError,
  type SqliteOpener,
} from "../ports/index.js";
import {
  createEventHistory,
  HISTORY_DB_NAME,
  type HistoryProjectionDefinition,
  openHistoryReader,
} from "./index.js";
import { plainProjection, ProbeSqliteOpener } from "./testing.js";

const NOW = 1_760_605_920_000;
const HOUR = 3_600_000;
const JUNK = "this is not a sqlite database ".repeat(20);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

class RecordingFilesystem extends NodeFilesystem {
  readonly renames: Array<{ readonly from: string; readonly to: string }> = [];
  beforeRename: (() => Promise<void>) | undefined;

  override async rename(from: string, to: string): Promise<void> {
    this.renames.push({ from, to });
    await this.beforeRename?.();
    await super.rename(from, to);
  }
}

interface Rig {
  readonly directory: string;
  readonly dbPath: string;
  readonly clock: FakeClock;
  readonly bus: EventBus;
  readonly logs: MemoryLogSink;
  readonly filesystem: RecordingFilesystem;
  readonly sqlite: SqliteOpener;
  history(options?: {
    readonly sqlite?: SqliteOpener;
    readonly retention?: number;
    readonly maxBytes?: number;
    readonly projections?: readonly HistoryProjectionDefinition[];
  }): ReturnType<typeof createEventHistory>;
}

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-history-"));
  directories.push(directory);
  return directory;
}

async function rig(
  options: { readonly capacity?: number; readonly directory?: string } = {},
): Promise<Rig> {
  const directory = options.directory ?? (await dataDirectory());
  const clock = new FakeClock(NOW);
  let nextId = 0;
  const bus = new EventBus(clock, options.capacity ?? 1_000, undefined, {
    generate: () => String((nextId += 1)).padStart(6, "0"),
  });
  const logs = new MemoryLogSink();
  const filesystem = new RecordingFilesystem();
  const sqlite = new NodeSqliteOpener();
  return {
    bus,
    clock,
    dbPath: join(directory, HISTORY_DB_NAME),
    directory,
    filesystem,
    history: (overrides = {}) =>
      createEventHistory({
        bus,
        clock,
        config: {
          maxBytes: overrides.maxBytes ?? 256 * 1024 * 1024,
          retention: overrides.retention ?? 7 * 24 * HOUR,
        },
        dataDirectory: directory,
        filesystem,
        logger: new JsonLinesLogger({ clock, sink: logs }),
        projectionOptions: { fleet: false, metricsRetentionMs: 90 * 24 * HOUR },
        projections: overrides.projections ?? [],
        sqlite: overrides.sqlite ?? sqlite,
      }),
    logs,
    sqlite,
  };
}

function stopping(bus: EventBus, reason: string): EventEnvelope {
  return bus.emit("daemon.stopping", { reason }, "daemon");
}

function relayed(bus: EventBus, id: string, timestamp: number): EventEnvelope {
  return bus.republish({
    event: "daemon.stopping",
    id,
    module: "daemon",
    payload: { reason: id },
    timestamp,
  });
}

function levelRecords(rigged: Rig, level: string): number {
  return rigged.logs.records.filter((record) => record.level === level).length;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

function recordingProjection(): {
  readonly definition: HistoryProjectionDefinition;
  readonly applied: string[];
  readonly pruned: number[];
} {
  const applied: string[] = [];
  const pruned: number[] = [];
  return {
    applied,
    definition: plainProjection("recording", () => ({
      apply: (envelope) => {
        applied.push(envelope.id);
      },
      prune: (now) => {
        pruned.push(now);
      },
    })),
    pruned,
  };
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function damagedNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes(".damaged-"));
}

async function readHistoryOf(directory: string): Promise<EventEnvelope[]> {
  return openHistoryReader({
    dataDirectory: directory,
    filesystem: new NodeFilesystem(),
    sqlite: new NodeSqliteOpener(),
  }).read({ sinceTs: 0 });
}

async function countRows(path: string, table: string): Promise<number> {
  const database = await new NodeSqliteOpener().open(path, { readOnly: true });
  try {
    return Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  } finally {
    database.close();
  }
}

const INSERTS_EVENT = /INSERT\s+(OR\s+IGNORE\s+)?INTO\s+events/i;

describe("createEventHistory", () => {
  it("creates history.db and its -wal and -shm files owner-only, mode 0o600", async () => {
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
  });

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

  it("opens a new file with incremental auto_vacuum, WAL, synchronous NORMAL and a 5 s busy timeout", async () => {
    const rigged = await rig();
    const sqlite = new ProbeSqliteOpener();
    const history = rigged.history({ sqlite });
    await history.start();

    expect(sqlite.connections).toHaveLength(1);
    const connection = sqlite.connections[0]!.database;
    const settings = {
      autoVacuum: connection.prepare("PRAGMA auto_vacuum").get(),
      busyTimeout: connection.prepare("PRAGMA busy_timeout").get(),
      journalMode: connection.prepare("PRAGMA journal_mode").get(),
      synchronous: connection.prepare("PRAGMA synchronous").get(),
    };
    await history.stop();
    expect(settings).toEqual({
      autoVacuum: { auto_vacuum: 2 },
      busyTimeout: { timeout: 5_000 },
      journalMode: { journal_mode: "wal" },
      synchronous: { synchronous: 1 },
    });
  });

  it("the factory touches no file and status() is opened false; start() writes this run's earlier events once each, and later events as they come", async () => {
    const rigged = await rig({ capacity: 3 });
    const history = rigged.history();
    for (const reason of ["a", "b", "c", "d", "e"]) stopping(rigged.bus, reason);
    const ring = rigged.bus.replay();

    expect(await readdir(rigged.directory)).toEqual([]);
    expect(history.status()).toEqual({ opened: false, writing: false });

    await history.start();
    const later = stopping(rigged.bus, "f");

    expect(history.status()).toEqual({ opened: true, writing: true });
    expect(await history.replay({ sinceTs: 0 })).toEqual([...ring, later]);
    await history.stop();
  });

  it("stop() while start() awaits its open leaves no file open, logs no error and arms no timer, a later start() does nothing, and no prune runs an hour later", async () => {
    const rigged = await rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sqlite = new ProbeSqliteOpener({ beforeOpen: () => gate });
    const projection = recordingProjection();
    const history = rigged.history({ projections: [projection.definition], sqlite });

    const starting = history.start();
    const stopped = history.stop();
    release();
    await Promise.all([starting, stopped]);
    await history.start();
    rigged.clock.advance(HOUR);
    await settle();

    expect(sqlite.connections.every((connection) => connection.closed)).toBe(true);
    expect(sqlite.opens).toBe(1);
    expect(levelRecords(rigged, "error")).toBe(0);
    expect(rigged.clock.pendingTimerCount).toBe(0);
    expect(projection.pruned).toEqual([]);
  });

  it.each([
    {
      kept: async (rigged: Rig, damaged: string) => {
        expect(await readFile(`${rigged.dbPath}-wal.damaged-${NOW}`, "utf8")).toBe("wal bytes");
        expect(await readFile(`${rigged.dbPath}-shm.damaged-${NOW}`, "utf8")).toBe("shm bytes");
        expect((await stat(damaged)).isDirectory()).toBe(true);
        expect(rigged.filesystem.renames.map(({ from }) => basename(from))).toEqual([
          "history.db-wal",
          "history.db-shm",
          "history.db",
        ]);
      },
      name: "a path that will not open",
      prepare: async (rigged: Rig) => {
        await mkdir(rigged.dbPath);
        await writeFile(`${rigged.dbPath}-wal`, "wal bytes");
        await writeFile(`${rigged.dbPath}-shm`, "shm bytes");
      },
      sqlite: () => new ProbeSqliteOpener(),
    },
    {
      kept: async (rigged: Rig, damaged: string) => {
        expect(await readFile(damaged, "utf8")).toBe(JUNK);
        expect(rigged.filesystem.renames.map(({ from }) => basename(from))).toEqual(["history.db"]);
      },
      name: "a file that is not a database",
      prepare: async (rigged: Rig) => {
        await writeFile(rigged.dbPath, JUNK);
      },
      sqlite: () => new ProbeSqliteOpener(),
    },
    {
      kept: async (rigged: Rig, damaged: string) => {
        expect(await countRows(damaged, "events")).toBe(1);
        expect(rigged.filesystem.renames.map(({ from }) => basename(from))).toEqual(["history.db"]);
      },
      name: "a file whose quick_check answers something but ok",
      prepare: async (rigged: Rig) => {
        const earlier = rigged.history();
        await earlier.start();
        stopping(rigged.bus, "earlier");
        await earlier.stop();
      },
      sqlite: () =>
        new ProbeSqliteOpener({
          answer: ({ connection, sql }) =>
            connection === 0 && /quick_check/i.test(sql)
              ? [{ quick_check: "row 3 missing from index idx" }]
              : undefined,
        }),
    },
  ])(
    "$name is renamed to history.db.damaged-<now> with its -wal and -shm, the main file last, a fresh file is written, and status() gives setAsideAt equal to now",
    async ({ kept, prepare, sqlite }) => {
      const rigged = await rig();
      await prepare(rigged);
      const history = rigged.history({ sqlite: sqlite() });

      await history.start();
      const fresh = stopping(rigged.bus, "fresh");

      expect(history.status()).toEqual({ opened: true, setAsideAt: NOW, writing: true });
      expect(await history.replay({ sinceTs: 0 })).toEqual([fresh]);
      await history.stop();
      await kept(rigged, join(rigged.directory, `history.db.damaged-${NOW}`));
    },
  );

  it("stop() while the damaged file is being set aside starts no fresh file", async () => {
    const rigged = await rig();
    await writeFile(rigged.dbPath, JUNK);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rigged.filesystem.beforeRename = () => gate;
    const sqlite = new ProbeSqliteOpener();
    const history = rigged.history({ sqlite });

    const starting = history.start();
    await settle();
    const stopped = history.stop();
    release();
    await Promise.all([starting, stopped]);

    expect(sqlite.opens).toBe(1);
    expect(await readdir(rigged.directory)).toEqual([`history.db.damaged-${NOW}`]);
  });

  it("a healthy file is not renamed, and keeps its rows", async () => {
    const rigged = await rig();
    const earlier = rigged.history();
    await earlier.start();
    const kept = stopping(rigged.bus, "kept");
    await earlier.stop();
    const next = await rig({ directory: rigged.directory });
    const history = next.history();

    await history.start();
    const replayed = await history.replay({ sinceTs: 0 });
    await history.stop();

    expect(next.filesystem.renames).toEqual([]);
    expect(history.status().setAsideAt).toBeUndefined();
    expect(replayed).toEqual([kept]);
    expect(await damagedNames(rigged.directory)).toEqual([]);
  });

  it(
    "a lock another connection holds past 5 s at open never sets the file aside, and leaves opened false",
    { timeout: 30_000 },
    async () => {
      const rigged = await rig();
      const earlier = rigged.history();
      await earlier.start();
      const kept = stopping(rigged.bus, "kept");
      await earlier.stop();
      const holder = await rigged.sqlite.open(rigged.dbPath, { readOnly: false });
      holder.exec("PRAGMA locking_mode=EXCLUSIVE");
      holder.exec("BEGIN EXCLUSIVE");
      const next = await rig({ directory: rigged.directory });
      const history = next.history();

      await history.start();
      holder.exec("COMMIT");
      holder.close();

      expect(history.status().opened).toBe(false);
      expect(next.filesystem.renames).toEqual([]);
      expect(await damagedNames(rigged.directory)).toEqual([]);
      expect(await readHistoryOf(rigged.directory)).toEqual([kept]);
    },
  );

  it("a lock another connection holds past 5 s at the check never sets the file aside, and leaves opened false", async () => {
    const rigged = await rig();
    const earlier = rigged.history();
    await earlier.start();
    const kept = stopping(rigged.bus, "kept");
    await earlier.stop();
    const next = await rig({ directory: rigged.directory });
    const locked = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "prepare" && /quick_check/.test(call.sql)) {
          throw Object.assign(new Error("database is locked"), { errcode: 5 });
        }
      },
    });
    const history = next.history({ sqlite: locked });

    await history.start();

    expect(history.status().opened).toBe(false);
    expect(next.filesystem.renames).toEqual([]);
    expect(await damagedNames(rigged.directory)).toEqual([]);
    expect(await readHistoryOf(rigged.directory)).toEqual([kept]);
  });

  it(
    "a lock another connection holds past 5 s at a write never sets the file aside; writing goes false",
    { timeout: 30_000 },
    async () => {
      const rigged = await rig();
      const history = rigged.history();
      await history.start();
      const kept = stopping(rigged.bus, "kept");
      const holder = await rigged.sqlite.open(rigged.dbPath, { readOnly: false });
      holder.exec("BEGIN IMMEDIATE");

      stopping(rigged.bus, "blocked");
      holder.exec("ROLLBACK");
      holder.close();

      expect(history.status().writing).toBe(false);
      expect(levelRecords(rigged, "error")).toBe(1);
      expect(rigged.filesystem.renames).toEqual([]);
      await history.stop();
      expect(await damagedNames(rigged.directory)).toEqual([]);
      expect(await readHistoryOf(rigged.directory)).toEqual([kept]);
    },
  );

  it(
    "a lock another connection holds past 5 s at a prune never sets the file aside; it logs one warning and writing goes on",
    { timeout: 30_000 },
    async () => {
      const rigged = await rig();
      const history = rigged.history({ retention: HOUR / 2 });
      await history.start();
      stopping(rigged.bus, "old");
      const holder = await rigged.sqlite.open(rigged.dbPath, { readOnly: false });
      holder.exec("BEGIN IMMEDIATE");

      rigged.clock.advance(HOUR);
      await settle();
      holder.exec("ROLLBACK");
      holder.close();
      const later = stopping(rigged.bus, "later");

      expect(levelRecords(rigged, "warn")).toBe(1);
      expect(history.status().writing).toBe(true);
      expect(rigged.filesystem.renames).toEqual([]);
      expect((await history.replay({ sinceTs: NOW })).at(-1)).toEqual(later);
      await history.stop();
    },
  );

  it("a failed load of node:sqlite leaves a healthy history.db byte-identical and in place, and opened false", async () => {
    const rigged = await rig();
    const earlier = rigged.history();
    await earlier.start();
    stopping(rigged.bus, "kept");
    await earlier.stop();
    const before = await readFile(rigged.dbPath);
    const unavailable: SqliteOpener = {
      open: () =>
        Promise.reject(new SqliteUnavailableError("No such built-in module: node:sqlite")),
    };
    const next = await rig({ directory: rigged.directory });
    const history = next.history({ sqlite: unavailable });

    await history.start();

    expect(history.status()).toEqual({ opened: false, writing: false });
    expect(next.filesystem.renames).toEqual([]);
    expect(await readFile(rigged.dbPath)).toEqual(before);
    expect(await damagedNames(rigged.directory)).toEqual([]);
  });

  it("when the fresh file cannot be opened either, opened and writing are false and replay answers the ring", async () => {
    const rigged = await rig({ capacity: 2 });
    await writeFile(rigged.dbPath, JUNK);
    const sqlite = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind === "open" && call.connection === 1) throw new Error("unable to open");
      },
    });
    const history = rigged.history({ sqlite });
    stopping(rigged.bus, "one");
    const two = stopping(rigged.bus, "two");
    const three = stopping(rigged.bus, "three");

    await history.start();

    expect(history.status().opened).toBe(false);
    expect(history.status().writing).toBe(false);
    expect(await history.replay({ sinceTs: 0 })).toEqual([two, three]);
    expect(await readFile(join(rigged.directory, `history.db.damaged-${NOW}`), "utf8")).toBe(JUNK);
    expect(rigged.filesystem.renames).toHaveLength(1);
    expect(
      rigged.logs.records.filter((record) => record.message.startsWith("The fresh history")),
    ).toHaveLength(1);
  });

  it("prune deletes event rows older than retention and keeps one stamped exactly at the cutoff", async () => {
    const rigged = await rig();
    const retention = 2 * HOUR;
    const cutoff = NOW - retention;
    relayed(rigged.bus, "evt_old", cutoff - 1);
    const atCutoff = relayed(rigged.bus, "evt_cutoff", cutoff);
    const newer = relayed(rigged.bus, "evt_newer", cutoff + 1);
    const history = rigged.history({ retention });

    await history.start();
    const replayed = await history.replay({ sinceTs: 0 });
    await history.stop();

    expect(replayed).toEqual([atCutoff, newer]);
  });

  it("prune deletes the oldest event rows, 1 000 per step, until their stored size fits maxBytes, keeps the newest, and after the prune history.db plus its -wal is smaller than before it and the -wal is empty", async () => {
    const rigged = await rig({ capacity: 10 });
    const writer = rigged.history();
    await writer.start();
    const padding = "é".repeat(1_000);
    const emitted: EventEnvelope[] = [];
    for (let index = 0; index < 2_500; index += 1) {
      rigged.clock.advance(1);
      emitted.push(stopping(rigged.bus, `${padding}${index}`));
    }
    await writer.stop();
    const storedSize = (envelope: EventEnvelope): number =>
      Buffer.byteLength(JSON.stringify(envelope), "utf8");
    const newest1200 = emitted
      .slice(-1_200)
      .reduce((sum, envelope) => sum + storedSize(envelope), 0);
    const diskSize = async (): Promise<number> =>
      (await sizeOf(rigged.dbPath)) + (await sizeOf(`${rigged.dbPath}-wal`));
    const before = await diskSize();
    const next = await rig({ directory: rigged.directory });
    const history = next.history({ maxBytes: newest1200 });

    await history.start();
    const kept = await history.replay({ sinceTs: 0 });
    // why: read while the file is open; closing it would drop the -wal and hide a missing checkpoint
    const after = await diskSize();
    const walAfter = await sizeOf(`${rigged.dbPath}-wal`);
    await history.stop();

    expect(kept).toEqual(emitted.slice(-500));
    expect(after).toBeLessThan(before);
    expect(walAfter).toBe(0);
  });

  it("the hourly prune counts the size of events written since start(), so it trims the oldest 1 000 at a time to maxBytes and the next hour trims nothing more", async () => {
    const rigged = await rig({ capacity: 10 });
    const storedSize = (envelope: EventEnvelope): number =>
      Buffer.byteLength(JSON.stringify(envelope), "utf8");
    const probe = stopping(rigged.bus, "0000");
    const history = rigged.history({ maxBytes: storedSize(probe) * 1_200 });
    await history.start();
    const emitted: EventEnvelope[] = [probe];
    for (let index = 0; index < 2_500; index += 1) {
      rigged.clock.advance(1);
      emitted.push(stopping(rigged.bus, String(index).padStart(4, "0")));
    }

    rigged.clock.advance(HOUR);
    await settle();
    const kept = await history.replay({ sinceTs: 0 });
    rigged.clock.advance(HOUR);
    await settle();
    const keptAfterSecondHour = await history.replay({ sinceTs: 0 });
    await history.stop();

    expect(kept).toEqual(emitted.slice(-501));
    expect(keptAfterSecondHour).toEqual(emitted.slice(-501));
  });

  it("prune runs again one hour after start() on the clock, not before, and stop() cancels it", async () => {
    const rigged = await rig();
    const history = rigged.history({ retention: HOUR / 2 });
    await history.start();
    const old = stopping(rigged.bus, "old");

    rigged.clock.advance(HOUR - 1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([old]);
    rigged.clock.advance(1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([]);

    const second = stopping(rigged.bus, "second");
    rigged.clock.advance(HOUR - 1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([second]);
    rigged.clock.advance(1);
    await settle();
    expect(await history.replay({ sinceTs: 0 })).toEqual([]);

    await history.stop();
    expect(rigged.clock.pendingTimerCount).toBe(0);
  });

  it("a prune step that throws logs one warning, writing goes on, and the next prune tries again", async () => {
    const rigged = await rig();
    let attempts = 0;
    const definition = plainProjection("failing-prune", () => ({
      apply: () => undefined,
      prune: () => {
        attempts += 1;
        throw new Error("prune failed");
      },
    }));
    const history = rigged.history({ projections: [definition] });
    await history.start();
    const attemptsAtStart = attempts;
    const warningsAtStart = levelRecords(rigged, "warn");

    rigged.clock.advance(HOUR);
    await settle();
    const afterFirst = attempts - attemptsAtStart;
    const warnings = levelRecords(rigged, "warn") - warningsAtStart;
    const later = stopping(rigged.bus, "later");
    rigged.clock.advance(HOUR);
    await settle();

    expect(afterFirst).toBe(1);
    expect(warnings).toBe(1);
    expect(attempts - attemptsAtStart).toBe(2);
    expect(history.status().writing).toBe(true);
    expect((await history.replay({ sinceTs: 0 })).at(-1)).toEqual(later);
    await history.stop();
  });

  it("a prune that fails after its age delete committed leaves the stored size true, so the next prune keeps rows under maxBytes", async () => {
    const rigged = await rig();
    const retention = 2 * HOUR;
    const old = [1, 2, 3].map((index) =>
      relayed(rigged.bus, `evt_old${index}`, NOW - 3 * HOUR + index),
    );
    const size = Buffer.byteLength(JSON.stringify(old[0]), "utf8");
    let attempts = 0;
    const definition = plainProjection("fails-once", () => ({
      apply: () => undefined,
      prune: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("prune failed");
      },
    }));
    const history = rigged.history({ maxBytes: size * 4, projections: [definition], retention });
    await history.start();
    const fresh = [1, 2, 3].map((index) => relayed(rigged.bus, `evt_new${index}`, NOW + index));

    rigged.clock.advance(HOUR);
    await settle();
    const kept = await history.replay({ sinceTs: 0 });
    await history.stop();

    expect(attempts).toBe(2);
    expect(kept).toEqual(fresh);
  });

  it("skips on replay a row whose id the envelope schema refuses", async () => {
    const rigged = await rig();
    const history = rigged.history();
    await history.start();
    const good = relayed(rigged.bus, "evt_good", NOW);
    relayed(rigged.bus, "not an id!", NOW + 1);
    const after = relayed(rigged.bus, "evt_after", NOW + 2);

    const replayed = await history.replay({ sinceTs: 0 });
    await history.stop();
    expect(replayed).toEqual([good, after]);
  });
});

describe("openHistoryReader", () => {
  it("reads rows a writer committed while that writer is still open", async () => {
    const rigged = await rig();
    const history = rigged.history();
    await history.start();
    const first = stopping(rigged.bus, "first");
    rigged.clock.advance(5);
    const second = stopping(rigged.bus, "second");

    const read = await readHistoryOf(rigged.directory);
    const sinceFirst = await openHistoryReader({
      dataDirectory: rigged.directory,
      filesystem: new NodeFilesystem(),
      sqlite: new NodeSqliteOpener(),
    }).read({ sinceTs: first.timestamp });
    await history.stop();

    expect(read).toEqual([first, second]);
    expect(sinceFirst).toEqual([second]);
  });

  it("opens history.db read-only", async () => {
    const rigged = await rig();
    const history = rigged.history();
    await history.start();
    const sqlite = new ProbeSqliteOpener();

    await openHistoryReader({
      dataDirectory: rigged.directory,
      filesystem: new NodeFilesystem(),
      sqlite,
    }).read({ sinceTs: 0 });
    await history.stop();

    expect(sqlite.connections.map((connection) => connection.readOnly)).toEqual([true]);
  });

  it("throws, and does not answer empty, when history.db cannot be examined for a reason other than being missing", async () => {
    const directory = await dataDirectory();
    class DeniedFilesystem extends NodeFilesystem {
      override async stat(): Promise<never> {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
    }

    await expect(
      openHistoryReader({
        dataDirectory: directory,
        filesystem: new DeniedFilesystem(),
        sqlite: new NodeSqliteOpener(),
      }).read({ sinceTs: 0 }),
    ).rejects.toThrow(/permission denied/);
  });

  it("answers empty when history.db is missing", async () => {
    const directory = await dataDirectory();

    expect(await readHistoryOf(directory)).toEqual([]);
  });

  it("throws when history.db is present and unreadable", async () => {
    const directory = await dataDirectory();
    await writeFile(join(directory, HISTORY_DB_NAME), JUNK);

    await expect(readHistoryOf(directory)).rejects.toThrow(/not a database/);
  });
});

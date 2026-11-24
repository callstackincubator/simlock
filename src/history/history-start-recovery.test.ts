import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteUnavailableError, type SqliteOpener } from "../ports/index.js";
import { ProbeSqliteOpener } from "./testing.js";
import {
  NOW,
  JUNK,
  directories,
  type Rig,
  rig,
  stopping,
  levelRecords,
  settle,
  recordingProjection,
  damagedNames,
  readHistoryOf,
  countRows,
} from "./test-history.js";
import { HOUR } from "./testing.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("createEventHistory", () => {
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
  });

  it("a stop while the rebuild hold waits makes the hold's stopped check true and runs no rebuild", async () => {
    const rigged = await rig();
    let rebuilt = 0;
    let holdEnded = false;
    const history = rigged.history({
      beforeRebuild: async (isStopped) => {
        while (!isStopped()) await new Promise<void>((next) => setImmediate(next));
        holdEnded = true;
      },
      projections: [
        {
          check: () => false,
          create: () => ({
            apply: () => undefined,
            prune: () => undefined,
            rebuild: () => {
              rebuilt += 1;
            },
          }),
          migrations: [],
          name: "stale",
          version: 0,
        },
      ],
    });
    const starting = history.start();
    await settle();

    await history.stop();
    await settle();
    await starting;

    expect(holdEnded).toBe(true);
    expect(rebuilt).toBe(0);
  });
});

import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProbeSqliteOpener } from "../history/testing.js";
import {
  NodeFilesystem,
  NodeSqliteOpener,
  NoopLogger,
  type SqliteOpener,
  type SqliteSchemaOwner,
} from "../ports/index.js";
import { openStateDatabase, STATE_DB_NAME } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const sqlite = new NodeSqliteOpener();

const owners: readonly SqliteSchemaOwner[] = [
  {
    migrations: [
      "CREATE TABLE runs (step TEXT NOT NULL) STRICT",
      "INSERT INTO runs VALUES ('alpha-1')",
    ],
    name: "alpha",
    version: 2,
  },
  {
    migrations: ["CREATE TABLE beta_rows (id TEXT NOT NULL) STRICT"],
    name: "beta",
    version: 1,
  },
];

async function newDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-state-"));
  directories.push(directory);
  return directory;
}

function open(dataDirectory: string, schemaOwners: readonly SqliteSchemaOwner[] = owners) {
  return openStateDatabase({
    dataDirectory,
    filesystem: new NodeFilesystem(),
    logger: new NoopLogger(),
    oldFiles: ["state.json"],
    owners: schemaOwners,
    sqlite,
    upgradeStep: "remove it.",
  });
}

describe("openStateDatabase", () => {
  it("on an empty folder creates state.db mode 0600 and records each owner's version, sets WAL, busy_timeout 5000 and synchronous NORMAL, and a second open runs no migration", async () => {
    const directory = await newDirectory();
    const path = join(directory, STATE_DB_NAME);

    const first = await open(directory);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      first.database.prepare("SELECT owner, version FROM schema_versions ORDER BY owner").all(),
    ).toEqual([
      { owner: "alpha", version: 2 },
      { owner: "beta", version: 1 },
    ]);
    expect(first.database.prepare("SELECT step FROM runs").all()).toEqual([{ step: "alpha-1" }]);
    expect(Object.values(first.database.prepare("PRAGMA journal_mode").get() ?? {})).toEqual([
      "wal",
    ]);
    expect(Object.values(first.database.prepare("PRAGMA busy_timeout").get() ?? {})).toEqual([
      5000,
    ]);
    expect(Object.values(first.database.prepare("PRAGMA synchronous").get() ?? {})).toEqual([1]);
    first.close();

    const second = await open(directory);
    expect(second.database.prepare("SELECT step FROM runs").all()).toEqual([{ step: "alpha-1" }]);
    second.close();
  });
});

describe("openStateDatabase refusals", () => {
  const SEE =
    "See https://callstackincubator.github.io/simlock/docs/worker/running-the-daemon#upgrade-simlock.";

  async function seeded(directory: string): Promise<string> {
    const path = join(directory, STATE_DB_NAME);
    const state = await open(directory);
    state.database.exec("CREATE TABLE padding (x TEXT)");
    for (let row = 0; row < 400; row += 1) {
      state.database
        .prepare("INSERT INTO padding (x) VALUES (?)")
        .run(`row-${String(row)}`.repeat(20));
    }
    state.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    state.close();
    return path;
  }

  it("refuses with each Shared values message, word for word, for an old file, a damaged file, a file that is not SQLite, a newer version and a migration that throws", async () => {
    const upgradeStep = "remove <path> and start again.";
    const refusal = async (
      directory: string,
      schemaOwners: readonly SqliteSchemaOwner[] = owners,
    ): Promise<string> => {
      try {
        const state = await openStateDatabase({
          dataDirectory: directory,
          filesystem: new NodeFilesystem(),
          logger: new NoopLogger(),
          oldFiles: ["state.json"],
          owners: schemaOwners,
          sqlite,
          upgradeStep,
        });
        state.close();
      } catch (error: unknown) {
        return (error as Error).message;
      }
      return "opened";
    };

    const oldFileDirectory = await newDirectory();
    await writeFile(join(oldFileDirectory, "state.json"), "{}");
    expect(await refusal(oldFileDirectory)).toBe(
      `Found ${join(oldFileDirectory, "state.json")}, which this Simlock no longer reads. To upgrade: remove ${join(oldFileDirectory, "state.json")} and start again. ${SEE}`,
    );
    expect(existsSync(join(oldFileDirectory, STATE_DB_NAME))).toBe(false);

    const notSqlite = await newDirectory();
    await writeFile(join(notSqlite, STATE_DB_NAME), "this is not a sqlite database ".repeat(20));
    expect(await refusal(notSqlite)).toBe(
      `${join(notSqlite, STATE_DB_NAME)} is damaged (open: file is not a database). Move it away to start with empty state; every device and lease it held is forgotten.`,
    );

    const damaged = await newDirectory();
    const damagedPath = await seeded(damaged);
    const bytes = await readFile(damagedPath);
    bytes.fill(0xff, 4096 * 3, 4096 * 8);
    await writeFile(damagedPath, bytes);
    expect(await refusal(damaged)).toMatch(
      new RegExp(
        `^${join(damaged, STATE_DB_NAME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is damaged \\(quick_check: .+\\)\\. Move it away to start with empty state; every device and lease it held is forgotten\\.$`,
      ),
    );

    const newer = await newDirectory();
    (await open(newer)).close();
    expect(
      await refusal(newer, [
        { ...owners[0]!, migrations: owners[0]!.migrations.slice(0, 1), version: 1 },
      ]),
    ).toBe(
      `alpha in ${join(newer, STATE_DB_NAME)} is at version 2; this Simlock knows up to 1. Upgrade Simlock, or move state.db away.`,
    );

    const failing = await newDirectory();
    const failingOwners: readonly SqliteSchemaOwner[] = [
      owners[0]!,
      {
        migrations: ["CREATE TABLE gamma (x INTEGER) STRICT", "INSERT INTO nowhere VALUES (1)"],
        name: "gamma",
        version: 2,
      },
    ];
    expect(await refusal(failing, failingOwners)).toBe(
      `gamma in ${join(failing, STATE_DB_NAME)} could not move from version 1 to 2: no such table: nowhere. Upgrade Simlock, or move state.db away.`,
    );
    const afterwards = await sqlite.open(join(failing, STATE_DB_NAME), { readOnly: true });
    expect(afterwards.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
      [],
    );
    afterwards.close();
  });

  it(
    "a lock held past 5 s at open, at the quick_check, at BEGIN IMMEDIATE and in a migration step gives the lock message, not the damage one",
    { timeout: 30_000 },
    async () => {
      const directory = await newDirectory();
      const path = join(directory, STATE_DB_NAME);
      const lockMessage = `${path} is locked by another process. Stop the other Simlock daemon using it, then start again.`;
      (await open(directory)).close();
      const refusal = async (opener: SqliteOpener, folder: string = directory): Promise<string> => {
        try {
          (
            await openStateDatabase({
              dataDirectory: folder,
              filesystem: new NodeFilesystem(),
              logger: new NoopLogger(),
              oldFiles: [],
              owners,
              sqlite: opener,
              upgradeStep: "",
            })
          ).close();
        } catch (error: unknown) {
          return (error as Error).message;
        }
        return "opened";
      };
      const lockedAt = (sql: string) =>
        new ProbeSqliteOpener({
          fault: (call) => {
            if (call.kind !== "open" && call.sql.startsWith(sql)) {
              throw Object.assign(new Error("database is locked"), { errcode: 5 });
            }
          },
        });

      expect(await refusal(lockedAt("PRAGMA quick_check"))).toBe(lockMessage);
      expect(await refusal(lockedAt("BEGIN IMMEDIATE"))).toBe(lockMessage);
      expect(await refusal(lockedAt("CREATE TABLE runs"), await newDirectory())).toBe(
        `${join(directories.at(-1)!, STATE_DB_NAME)} is locked by another process. Stop the other Simlock daemon using it, then start again.`,
      );

      const holder = await sqlite.open(path, { readOnly: false });
      holder.exec("PRAGMA locking_mode=EXCLUSIVE");
      holder.exec("BEGIN EXCLUSIVE");
      const message = await refusal(sqlite);
      holder.exec("COMMIT");
      holder.close();
      expect(message).toBe(lockMessage);
    },
  );

  it("reads the versions inside the write transaction, so two daemons starting at once migrate once", async () => {
    const directory = await newDirectory();
    let racing = false;
    const other = await sqlite.open(join(directory, STATE_DB_NAME), { readOnly: false });
    const racingOpener = new ProbeSqliteOpener({
      fault: (call) => {
        if (call.kind !== "exec" || call.sql !== "BEGIN IMMEDIATE" || racing) return;
        racing = true;
        other.exec("BEGIN IMMEDIATE");
        other.exec(
          "CREATE TABLE schema_versions (owner TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT",
        );
        other.exec(owners[0]!.migrations.join(";"));
        other.exec("CREATE TABLE beta_rows (id TEXT NOT NULL) STRICT");
        other.exec("INSERT INTO schema_versions VALUES ('alpha', 2), ('beta', 1)");
        other.exec("COMMIT");
        other.close();
      },
    });

    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new NodeFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners,
      sqlite: racingOpener,
      upgradeStep: "",
    });

    expect(racing).toBe(true);
    expect(state.database.prepare("SELECT step FROM runs").all()).toEqual([{ step: "alpha-1" }]);
    state.close();
  });
});

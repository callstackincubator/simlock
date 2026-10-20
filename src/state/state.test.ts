import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NodeFilesystem,
  NodeSqliteOpener,
  NoopLogger,
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
  it("on an empty folder creates state.db mode 0600 and records each owner's version, and a second open runs no migration", async () => {
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
    first.close();

    const second = await open(directory);
    expect(second.database.prepare("SELECT step FROM runs").all()).toEqual([{ step: "alpha-1" }]);
    second.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { androidSourceDataOwner } from "../drivers/android/index.js";
import { iosSourceDataOwner } from "../drivers/ios/index.js";
import {
  NodeFilesystem,
  NodeSqliteOpener,
  NoopLogger,
  type SqliteDatabase,
  type SqliteSchemaOwner,
} from "../ports/index.js";
import { openStateDatabase } from "../state/index.js";
import { productionDeviceDataTables } from "./driver-discovery.js";
import { stateOwners } from "./main.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function newDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-state-owners-"));
  directories.push(directory);
  return directory;
}

function open(dataDirectory: string, owners: readonly SqliteSchemaOwner[]) {
  return openStateDatabase({
    dataDirectory,
    filesystem: new NodeFilesystem(),
    logger: new NoopLogger(),
    oldFiles: [],
    owners,
    sqlite: new NodeSqliteOpener(),
    upgradeStep: "",
  });
}

interface SeedTable {
  readonly owner: SqliteSchemaOwner;
  readonly table: string;
  readonly insert: (
    database: SqliteDatabase,
    row: { id: string; kind: string; specKey: string; state: string; createdAt: number },
  ) => void;
}

const seedTables: readonly SeedTable[] = [
  {
    owner: iosSourceDataOwner,
    table: "ios_source_data",
    insert: (database, row) => {
      database
        .prepare(
          `INSERT INTO ios_source_data (source_id, kind, spec_key, udid, set_path, device_type_id,
             runtime_id, model, os_version, state, maker, created_at)
           VALUES (?, ?, ?, ?, '/sources', 'type', 'runtime', 'iPhone 16', '18.4', ?, 'old', ?)`,
        )
        .run(row.id, row.kind, row.specKey, `udid-${row.id}`, row.state, row.createdAt);
    },
  },
  {
    owner: androidSourceDataOwner,
    table: "android_source_data",
    insert: (database, row) => {
      database
        .prepare(
          `INSERT INTO android_source_data (source_id, kind, state, spec_key, model, os_version,
             image_tag, folder, avd_name, image_identity, emulator_version, created_at)
           VALUES (?, ?, ?, ?, 'Pixel 9', '15', 'google_apis', ?, 'simlock', 'image', '36.1', ?)`,
        )
        .run(row.id, row.kind, row.state, row.specKey, `/sources/${row.id}`, row.createdAt);
    },
  },
];

describe("the seed tables' one-ready-seed-per-kind index (#1367)", () => {
  it.each(seedTables)(
    "$table: a new state.db refuses a second ready seed of one kind, and lets a ready baseline and another kind's ready seed in",
    async ({ owner, table, insert }) => {
      const state = await open(await newDirectory(), [owner]);
      try {
        insert(state.database, {
          createdAt: 1,
          id: "a",
          kind: "seed",
          specKey: "k1",
          state: "ready",
        });
        insert(state.database, {
          createdAt: 2,
          id: "b",
          kind: "baseline",
          specKey: "k1",
          state: "ready",
        });
        insert(state.database, {
          createdAt: 3,
          id: "c",
          kind: "seed",
          specKey: "k2",
          state: "ready",
        });

        expect(() =>
          insert(state.database, {
            createdAt: 4,
            id: "d",
            kind: "seed",
            specKey: "k1",
            state: "ready",
          }),
        ).toThrow(`UNIQUE constraint failed: ${table}.spec_key`);
      } finally {
        state.close();
      }
    },
  );

  it.each(seedTables)(
    "$table: a state.db at version 1 moves to version 2 at open, keeping the newest ready seed of each kind (a tie kept by the larger source id), demoting the others to making, leaving baselines and making rows out of the comparison, and refusing a second ready seed afterwards",
    async ({ owner, table, insert }) => {
      const directory = await newDirectory();
      const versionOne: SqliteSchemaOwner = {
        migrations: [owner.migrations[0] ?? ""],
        name: owner.name,
        version: 1,
      };
      const old = await open(directory, [versionOne]);
      const rows: readonly [string, string, string, number][] = [
        ["k1-z", "seed", "k1", 10],
        ["k1-a", "seed", "k1", 20],
        ["k1-base", "baseline", "k1", 5],
        ["k2-a", "seed", "k2", 30],
        ["k2-b", "seed", "k2", 30],
        ["k3", "seed", "k3", 40],
        ["k4-seed", "seed", "k4", 45],
        ["k4-base", "baseline", "k4", 60],
        ["k5-ready", "seed", "k5", 46],
      ];
      for (const [id, kind, specKey, createdAt] of rows) {
        insert(old.database, { createdAt, id, kind, specKey, state: "ready" });
      }
      insert(old.database, {
        createdAt: 70,
        id: "k5-making",
        kind: "seed",
        specKey: "k5",
        state: "making",
      });
      old.close();

      const state = await open(directory, [owner]);
      try {
        expect(
          state.database
            .prepare("SELECT version FROM schema_versions WHERE owner = ?")
            .get(owner.name),
        ).toEqual({ version: 2 });
        expect(
          state.database
            .prepare(`SELECT source_id, kind, state FROM ${table} ORDER BY source_id`)
            .all(),
        ).toEqual([
          { kind: "seed", source_id: "k1-a", state: "ready" },
          { kind: "baseline", source_id: "k1-base", state: "ready" },
          { kind: "seed", source_id: "k1-z", state: "making" },
          { kind: "seed", source_id: "k2-a", state: "making" },
          { kind: "seed", source_id: "k2-b", state: "ready" },
          { kind: "seed", source_id: "k3", state: "ready" },
          { kind: "baseline", source_id: "k4-base", state: "ready" },
          { kind: "seed", source_id: "k4-seed", state: "ready" },
          { kind: "seed", source_id: "k5-making", state: "making" },
          { kind: "seed", source_id: "k5-ready", state: "ready" },
        ]);
        expect(() =>
          insert(state.database, {
            createdAt: 50,
            id: "k3-new",
            kind: "seed",
            specKey: "k3",
            state: "ready",
          }),
        ).toThrow(`UNIQUE constraint failed: ${table}.spec_key`);
      } finally {
        state.close();
      }
    },
  );

  it.each(["worker", "gateway"] as const)(
    "every schema owner a %s opens has one migration per version",
    (role) => {
      const owners = stateOwners(role, productionDeviceDataTables());

      expect(owners.length).toBeGreaterThan(1);
      expect(
        owners.map((owner) => ({ migrations: owner.migrations.length, name: owner.name })),
      ).toEqual(owners.map((owner) => ({ migrations: owner.version, name: owner.name })));
    },
  );
});

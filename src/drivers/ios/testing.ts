import { NodeSqliteOpener, type SqliteDatabase } from "../../ports/index.js";
import { iosSourceDataOwner, IosSourceTable } from "./source-data.js";

export async function memorySourceDatabase(): Promise<SqliteDatabase> {
  const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
  for (const migration of iosSourceDataOwner.migrations) database.exec(migration);
  return database;
}

export function plantReadySeed(
  database: SqliteDatabase,
  seed: { readonly deviceTypeId: string; readonly runtimeId: string; readonly udid: string },
): SqliteDatabase {
  const table = new IosSourceTable(database);
  table.insertMaking({
    createdAt: 0,
    deviceTypeId: seed.deviceTypeId,
    kind: "seed",
    maker: "planted",
    model: "iPhone 16",
    osVersion: "26.5",
    runtimeBuild: undefined,
    runtimeId: seed.runtimeId,
    setPath: "/Devices/sources",
    sourceId: `planted-${seed.udid}`,
    specKey: `${seed.deviceTypeId}\u0000${seed.runtimeId}`,
  });
  table.setUdid(`planted-${seed.udid}`, seed.udid);
  table.markReady(`planted-${seed.udid}`, undefined);
  return database;
}

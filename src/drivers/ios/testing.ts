import { NodeSqliteOpener, type SqliteDatabase } from "../../ports/index.js";
import { iosSourceDataOwner, IosSourceTable } from "./source-data.js";

export async function memorySourceDatabase(): Promise<SqliteDatabase> {
  const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
  for (const migration of iosSourceDataOwner.migrations) database.exec(migration);
  return database;
}

export interface PlantedSource {
  readonly deviceTypeId: string;
  readonly maker?: string;
  readonly model?: string;
  readonly osVersion?: string;
  readonly runtimeBuild?: string;
  readonly runtimeId: string;
  readonly sizeBytes?: number;
  readonly state?: "making" | "ready";
  readonly udid?: string;
}

/** why: a source row as an earlier process, or an earlier call of this one, left it, so a test starts from the row and not from the make. */
export function plantSource(database: SqliteDatabase, source: PlantedSource): SqliteDatabase {
  const table = new IosSourceTable(database);
  const sourceId = `planted-${source.udid ?? source.maker ?? "making"}-${source.runtimeId}`;
  table.insertMaking({
    createdAt: 0,
    deviceTypeId: source.deviceTypeId,
    kind: "seed",
    maker: source.maker ?? "planted",
    model: source.model ?? "iPhone 16",
    osVersion: source.osVersion ?? "26.5",
    runtimeBuild: source.runtimeBuild,
    runtimeId: source.runtimeId,
    setPath: "/Devices/sources",
    sourceId,
    specKey: `${source.deviceTypeId}\u0000${source.runtimeId}`,
  });
  if (source.udid !== undefined) table.setUdid(sourceId, source.udid);
  if (source.state !== "making") table.markReady(sourceId, source.sizeBytes);
  return database;
}

export function plantReadySeed(
  database: SqliteDatabase,
  seed: Omit<PlantedSource, "state"> & { readonly udid: string },
): SqliteDatabase {
  return plantSource(database, seed);
}

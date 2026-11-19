import { NodeSqliteOpener, type MemoryFilesystem, type SqliteDatabase } from "../../ports/index.js";
import { iosSourceDataOwner, IosSourceTable, type SourceFile } from "./source-data.js";

export async function memorySourceDatabase(): Promise<SqliteDatabase> {
  const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
  for (const migration of iosSourceDataOwner.migrations) database.exec(migration);
  return database;
}

export interface PlantedSource {
  readonly deviceTypeId: string;
  /** why: the files that name the lineage, as a source's make recorded them. */
  readonly files?: readonly SourceFile[];
  /** why: `null` is a source made before lineages were kept; absent is a lineage of no simulator. */
  readonly lineage?: readonly string[] | null;
  readonly savedWithoutLineage?: boolean;
  /** why: a seed saved after a copy of it settled (ADR 0090); absent is a quick seed. */
  readonly settled?: boolean;
  /** why: the plain leases already copied from this seed (ADR 0090). */
  readonly leases?: number;
  /** why: the row of a settle, or of the quick seed it retired, names the other seed (ADR 0090). */
  readonly settleOf?: string;
  readonly createdAt?: number;
  readonly kind?: "seed" | "baseline";
  readonly maker?: string;
  readonly model?: string;
  readonly osVersion?: string;
  readonly runtimeBuild?: string;
  readonly runtimeId: string;
  readonly sizeBytes?: number;
  readonly state?: "making" | "ready";
  readonly throwawayUdid?: string;
  readonly udid?: string;
}

/** why: a source row as an earlier process, or an earlier call of this one, left it, so a test starts from the row and not from the make. */
export function plantSource(database: SqliteDatabase, source: PlantedSource): SqliteDatabase {
  const table = new IosSourceTable(database);
  const sourceId = `planted-${source.udid ?? source.maker ?? "making"}-${source.runtimeId}`;
  table.insertMaking({
    createdAt: source.createdAt ?? 0,
    deviceTypeId: source.deviceTypeId,
    kind: source.kind ?? "seed",
    maker: source.maker ?? "planted",
    model: source.model ?? "iPhone 16",
    osVersion: source.osVersion ?? "26.5",
    runtimeBuild: source.runtimeBuild,
    runtimeId: source.runtimeId,
    ...(source.settleOf === undefined ? {} : { settleOf: source.settleOf }),
    setPath: "/Devices/sources",
    sourceId,
    specKey: `${source.deviceTypeId}\u0000${source.runtimeId}`,
  });
  if (source.udid !== undefined) table.setUdid(sourceId, source.udid);
  if (source.throwawayUdid !== undefined) table.setThrowaway(sourceId, source.throwawayUdid);
  if (source.state !== "making") {
    table.markReady(sourceId, source.sizeBytes, {
      files: source.files ?? [],
      lineage: source.lineage === null ? undefined : (source.lineage ?? []),
      savedWithoutLineage: source.savedWithoutLineage ?? false,
    });
  }
  markUsed(database, sourceId, source);
  return database;
}

function markUsed(database: SqliteDatabase, sourceId: string, source: PlantedSource): void {
  database
    .prepare("UPDATE ios_source_data SET settled = ?, lease_count = ? WHERE source_id = ?")
    .run(source.settled === true ? 1 : 0, source.leases ?? 0, sourceId);
}

export function plantReadySeed(
  database: SqliteDatabase,
  seed: Omit<PlantedSource, "state"> & { readonly udid: string },
): SqliteDatabase {
  return plantSource(database, seed);
}

/** why: a file with the exact bytes a test names, which `writeFileAtomic` cannot hold for a UTF-16 or binary one. */
export async function plantBytes(
  filesystem: MemoryFilesystem,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
  await filesystem.writeFileStream(
    path,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  );
}

export async function readBytes(filesystem: MemoryFilesystem, path: string): Promise<Buffer> {
  const file = await filesystem.openFile(path);
  const chunks: Uint8Array[] = [];
  const reader = file.read().getReader();
  for (;;) {
    const piece = await reader.read();
    if (piece.done) break;
    chunks.push(piece.value);
  }
  await file.close();
  return Buffer.concat(chunks);
}

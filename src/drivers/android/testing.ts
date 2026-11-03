import { NodeSqliteOpener, type SqliteDatabase } from "../../ports/index.js";

export async function memoryAndroidSourceDatabase(): Promise<SqliteDatabase> {
  return await new NodeSqliteOpener().open(":memory:", { readOnly: false });
}

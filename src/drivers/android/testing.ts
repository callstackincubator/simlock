import { NodeSqliteOpener, type SqliteDatabase } from "../../ports/index.js";
import { androidSourceDataOwner } from "./source-data.js";

export async function memoryAndroidSourceDatabase(): Promise<SqliteDatabase> {
  const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
  for (const migration of androidSourceDataOwner.migrations) database.exec(migration);
  return database;
}

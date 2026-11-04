import { NodeSqliteOpener, type SqliteDatabase } from "../../ports/index.js";
import { androidSourceDataOwner } from "./source-data.js";

export { locateSdk, type AndroidSdkPaths } from "./sdk-paths.js";

export async function memoryAndroidSourceDatabase(): Promise<SqliteDatabase> {
  const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
  for (const migration of androidSourceDataOwner.migrations) database.exec(migration);
  return database;
}

import { DatabaseSync } from "node:sqlite";

import type { SqliteDatabase } from "../../ports/index.js";
import { iosSourceDataOwner } from "./source-data.js";

export function memorySourceDatabase(): SqliteDatabase {
  const database = new DatabaseSync(":memory:");
  for (const migration of iosSourceDataOwner.migrations) database.exec(migration);
  return database;
}

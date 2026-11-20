import { join } from "node:path";
import { NodeSqliteOpener } from "../ports/index.js";

export async function queryState(
  directory: string,
  sql: string,
): Promise<readonly Record<string, unknown>[]> {
  const database = await new NodeSqliteOpener().open(join(directory, "state.db"), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

import { join } from "node:path";

import type { Filesystem } from "../ports/index.js";
import { HISTORY_DB_NAME } from "./names.js";

export async function setAsideDamagedHistory(
  filesystem: Filesystem,
  dataDirectory: string,
  now: number,
): Promise<string> {
  const main = join(dataDirectory, HISTORY_DB_NAME);
  for (const path of [`${main}-wal`, `${main}-shm`]) {
    if (await filesystem.exists(path)) await filesystem.rename(path, `${path}.damaged-${now}`);
  }
  const damaged = `${main}.damaged-${now}`;
  await filesystem.rename(main, damaged);
  return damaged;
}

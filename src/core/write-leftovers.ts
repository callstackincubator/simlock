import { join } from "node:path";
import type { Filesystem, Logger, ProcessSupervisor } from "../ports/index.js";

const LEFTOVER_NAME =
  /^\.[^/]+\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export interface SweepWriteLeftoversOptions {
  readonly directories: readonly string[];
  readonly filesystem: Filesystem;
  readonly logger: Logger;
  readonly processSupervisor: ProcessSupervisor;
}

export async function sweepWriteLeftovers(options: SweepWriteLeftoversOptions): Promise<void> {
  const { filesystem, logger, processSupervisor } = options;
  const uid = process.getuid?.();
  for (const directory of new Set(options.directories)) {
    let names: string[];
    try {
      names = await filesystem.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = LEFTOVER_NAME.exec(name);
      if (match === null) continue;
      const pid = Number(match[1]);
      if (processSupervisor.isAlive(pid)) continue;
      const path = join(directory, name);
      try {
        const details = await filesystem.lstat(path);
        if (details.kind !== "file" || (uid !== undefined && details.uid !== uid)) continue;
        await filesystem.rm(path);
        logger.info("removed an interrupted write's leftover", { path, pid });
      } catch (error: unknown) {
        logger.warn("could not remove an interrupted write's leftover", { error, path });
      }
    }
  }
}

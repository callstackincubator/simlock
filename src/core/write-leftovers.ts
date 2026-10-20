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
  for (const directory of new Set(options.directories)) {
    let names: string[];
    try {
      names = await options.filesystem.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const pid = abandonedWriterPid(name, options.processSupervisor);
      if (pid !== undefined) await removeLeftover(join(directory, name), pid, options);
    }
  }
}

function abandonedWriterPid(
  name: string,
  processSupervisor: ProcessSupervisor,
): number | undefined {
  const match = LEFTOVER_NAME.exec(name);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return processSupervisor.isAlive(pid) ? undefined : pid;
}

async function removeLeftover(
  path: string,
  pid: number,
  { filesystem, logger }: SweepWriteLeftoversOptions,
): Promise<void> {
  const uid = process.getuid?.();
  try {
    const details = await filesystem.lstat(path);
    if (details.kind !== "file" || (uid !== undefined && details.uid !== uid)) return;
    await filesystem.rm(path);
    logger.info("removed an interrupted write's leftover", { path, pid });
  } catch (error: unknown) {
    logger.warn("could not remove an interrupted write's leftover", { error, path });
  }
}

import { basename, dirname, join } from "node:path";
import type { Filesystem, Logger, ProcessSupervisor } from "../ports/index.js";

const TEMPORARY_FILE =
  /^\.[^/]+\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const STAGING_WRITER_AND_ID = /^(\d+)\.[^./]+$/;
const STAGING_ID = /^[^./]+$/;

export interface SweepWriteLeftoversOptions {
  readonly directories: readonly string[];
  /** why: staging names are matched against these roots' own names, so a user's directory that merely looks like one is never touched. */
  readonly deviceRoots: readonly string[];
  readonly filesystem: Filesystem;
  readonly logger: Logger;
  readonly processSupervisor: ProcessSupervisor;
  readonly uid?: number;
}

export async function sweepWriteLeftovers(options: SweepWriteLeftoversOptions): Promise<void> {
  const parents = new Set(options.deviceRoots.map((root) => dirname(root)));
  for (const directory of new Set([...options.directories, ...parents])) {
    let names: string[];
    try {
      names = await options.filesystem.readdir(directory);
    } catch {
      continue;
    }
    const rootNames = options.deviceRoots
      .filter((root) => dirname(root) === directory)
      .map((root) => basename(root));
    const temporaryToo = options.directories.includes(directory);
    for (const name of names)
      await sweepEntry(join(directory, name), rootNames, temporaryToo, options);
  }
}

async function sweepEntry(
  path: string,
  rootNames: readonly string[],
  temporaryToo: boolean,
  options: SweepWriteLeftoversOptions,
): Promise<void> {
  const name = basename(path);
  const temporary = temporaryToo ? TEMPORARY_FILE.exec(name) : null;
  if (temporary !== null) return removeIfAbandoned(path, temporary[1], options);
  for (const rootName of rootNames) {
    const staging = stagingWriter(name, rootName);
    if (staging === "legacy")
      options.logger.info("left a legacy staging directory in place", { path });
    else if (staging !== undefined) await removeIfAbandoned(path, staging, options);
  }
}

function stagingWriter(name: string, rootName: string): string | "legacy" | undefined {
  const prefix = `.${rootName}.`;
  if (!name.startsWith(prefix) || !name.endsWith(".staging")) return undefined;
  const middle = name.slice(prefix.length, name.length - ".staging".length);
  const writer = STAGING_WRITER_AND_ID.exec(middle);
  if (writer !== null) return writer[1];
  return STAGING_ID.test(middle) ? "legacy" : undefined;
}

async function removeIfAbandoned(
  path: string,
  writer: string | undefined,
  options: SweepWriteLeftoversOptions,
): Promise<void> {
  const pid = Number(writer);
  if (options.processSupervisor.isAlive(pid)) return;
  await removeLeftover(path, pid, options);
}

async function removeLeftover(
  path: string,
  pid: number,
  { filesystem, logger, uid }: SweepWriteLeftoversOptions,
): Promise<void> {
  try {
    const details = await filesystem.lstat(path);
    if (
      details.kind !== (path.endsWith(".staging") ? "directory" : "file") ||
      (uid !== undefined && details.uid !== uid)
    )
      return;
    await filesystem.rm(path);
    logger.info("removed an interrupted write's leftover", { path, pid });
  } catch (error: unknown) {
    logger.warn("could not remove an interrupted write's leftover", { error, path });
  }
}

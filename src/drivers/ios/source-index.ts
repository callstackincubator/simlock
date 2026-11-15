import { join } from "node:path";

import type { Filesystem, Logger, SqliteOpener } from "../../ports/index.js";
import { namesAnyFolder, type ForeignFolders } from "./foreign-folders.js";
import type { SourceFile } from "./source-data.js";

const WAL_SUFFIX = "-wal";
/** why: a clone drops this file before its swap (`dropLaunchServicesDatabase`), so it is never one the swap can patch. */
export const LAUNCH_SERVICES_DATABASE =
  /^data\/var\/db\/lsd\/com\.apple\.LaunchServices-.*\.csstore$/;
const CHECKPOINT = "PRAGMA wal_checkpoint(TRUNCATE)";

export interface SourceIndexOptions {
  readonly filesystem: Filesystem;
  readonly folders: Omit<ForeignFolders, "ownUdid">;
  readonly logger: Logger | undefined;
  readonly sqlite: SqliteOpener | undefined;
}

interface Entry extends SourceFile {
  readonly path: string;
  readonly size: number;
}

/**
 * why: a file is read whole to find the folders it names and again to swap them, and a used simulator
 * holds files of hundreds of megabytes (past the limit of one string); none of them is a settings file, so
 * a larger one is left out and logged.
 */
export const MAX_INDEXED_BYTES = 64 * 1024 * 1024;

/**
 * why: ADR 0076 §2: a WAL frame carries a checksum a swap would break, so every WAL of a made source is
 * flushed into its database first; then the files and links that name a device or log folder are found
 * once, and each copy swaps only those. A WAL that cannot be flushed is logged and left out, never patched.
 */
export async function indexSource(
  root: string,
  options: SourceIndexOptions,
): Promise<readonly SourceFile[]> {
  const unflushed = new Set<string>();
  for (const entry of await walk(options.filesystem, root, "")) {
    if (entry.kind === "file" && entry.path.endsWith(WAL_SUFFIX)) {
      if (!(await flush(entry.path.slice(0, -WAL_SUFFIX.length), options))) {
        unflushed.add(entry.path);
      }
    }
  }
  // why: closing a flushed database deletes its `-wal` and `-shm`, so the files are listed again after the flush.
  const indexed: SourceFile[] = [];
  for (const entry of await walk(options.filesystem, root, "")) {
    if (unflushed.has(entry.path) || LAUNCH_SERVICES_DATABASE.test(entry.relativePath)) continue;
    if (entry.kind === "file" && entry.size > MAX_INDEXED_BYTES) {
      options.logger?.warn(
        `not searching ${entry.path} for folders to swap: its ${String(entry.size)} bytes are past ${String(MAX_INDEXED_BYTES)}`,
      );
      continue;
    }
    const bytes = await readEntry(entry, options.filesystem);
    if (bytes === undefined) continue;
    if (namesAnyFolder(bytes, options.folders)) {
      indexed.push({ kind: entry.kind, relativePath: entry.relativePath });
    }
  }
  return indexed;
}

/**
 * why: macOS refuses `open` on some files of a simulator's own folder (`locationd`'s) even to the
 * owner, as `EPERM`; the simulator's own daemon writes them, so a file we cannot read is one no
 * swap could patch either, and it is left out rather than failing the make.
 */
async function readEntry(entry: Entry, filesystem: Filesystem): Promise<Uint8Array | undefined> {
  try {
    return entry.kind === "link"
      ? Buffer.from(await filesystem.readlink(entry.path))
      : await filesystem.readBytes(entry.path);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return undefined;
    throw error;
  }
}

async function walk(filesystem: Filesystem, directory: string, relative: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  let names: string[];
  try {
    names = await filesystem.readdir(directory);
  } catch (error: unknown) {
    // why: a folder that is not there holds nothing to record; `simctl` made it, and its size is counted the same way.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries;
    throw error;
  }
  for (const name of names) {
    const path = join(directory, name);
    const relativePath = relative === "" ? name : `${relative}/${name}`;
    const { kind, size } = await filesystem.lstat(path);
    if (kind === "directory") entries.push(...(await walk(filesystem, path, relativePath)));
    else if (kind === "file" || kind === "symlink") {
      entries.push({ kind: kind === "file" ? "file" : "link", path, relativePath, size });
    }
  }
  return entries;
}

async function flush(database: string, options: SourceIndexOptions): Promise<boolean> {
  try {
    if (options.sqlite === undefined) throw new Error("no SQLite is available");
    if (!(await options.filesystem.exists(database))) throw new Error("its database is gone");
    const opened = await options.sqlite.open(database, { readOnly: false });
    try {
      opened.exec(CHECKPOINT);
    } finally {
      opened.close();
    }
    return true;
  } catch (error: unknown) {
    options.logger?.warn(
      `could not flush ${database}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

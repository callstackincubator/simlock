import { join } from "node:path";

import type { Filesystem, Logger, SqliteOpener } from "../../ports/index.js";
import { namesAnyFolder, type ForeignFolders } from "./foreign-folders.js";
import type { SourceFile } from "./source-data.js";

const WAL_SUFFIX = "-wal";
const CHECKPOINT = "PRAGMA wal_checkpoint(TRUNCATE)";

export interface SourceIndexOptions {
  readonly filesystem: Filesystem;
  readonly folders: Omit<ForeignFolders, "ownUdid">;
  readonly logger: Logger | undefined;
  readonly sqlite: SqliteOpener | undefined;
}

interface Entry extends SourceFile {
  readonly path: string;
}

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
    if (unflushed.has(entry.path)) continue;
    const bytes =
      entry.kind === "link"
        ? Buffer.from(await options.filesystem.readlink(entry.path))
        : await options.filesystem.readBytes(entry.path);
    if (namesAnyFolder(bytes, options.folders)) {
      indexed.push({ kind: entry.kind, relativePath: entry.relativePath });
    }
  }
  return indexed;
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
    const { kind } = await filesystem.lstat(path);
    if (kind === "directory") entries.push(...(await walk(filesystem, path, relativePath)));
    else if (kind === "file" || kind === "symlink") {
      entries.push({ kind: kind === "file" ? "file" : "link", path, relativePath });
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

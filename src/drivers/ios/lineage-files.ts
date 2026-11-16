import { DriverCrashError } from "../../core/index.js";
import {
  isMissingPathError,
  type Filesystem,
  type Logger,
  type SqliteOpener,
} from "../../ports/index.js";
import { errorMessage } from "./command-run.js";
import type { SourceFile } from "./source-data.js";
import { SWAP_OVERLAP_BYTES, namesLineage, swapLineage, type LineageSwap } from "./udid-swap.js";

/** why: a window is read whole, so this bounds memory at any file size (ADR 0076 §3). */
const WINDOW_BYTES = 1_048_576;

const WAL_SUFFIX = "-wal";

/** why: ADR 0076 §4: before its first boot a copy's recorded files name its own UDID in place of the lineage's, each file keeping its length. */
export async function swapCopyFiles(
  filesystem: Filesystem,
  folder: string,
  files: readonly SourceFile[],
  swap: LineageSwap,
): Promise<void> {
  for (const file of files) {
    if (file.kind !== "file") continue;
    const path = `${folder}/${file.relativePath}`;
    await eachWindow(filesystem, path, async (window, start) => {
      const swapped = swapLineage(window, swap);
      if (swapped.length !== window.length) {
        throw new DriverCrashError(`swapping UDIDs in ${path} changed its length`);
      }
      if (!Buffer.from(swapped).equals(window)) await filesystem.writeAt(path, start, swapped);
      return false;
    });
  }
}

export interface RecordOptions {
  readonly filesystem: Filesystem;
  /** why: the source's UDID folder; recorded paths are relative to it. */
  readonly folder: string;
  readonly lineage: readonly string[];
  readonly logger: Logger | undefined;
  readonly sqlite: SqliteOpener | undefined;
  readonly udid: string;
}

/**
 * why: ADR 0076 §3: when a source is made every WAL in it is flushed into its database, and the files and links that name a lineage UDID are found once and recorded, so a copy patches only those.
 */
export async function recordLineageFiles(options: RecordOptions): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const name of (await options.filesystem.readdir(directory)).sort()) {
      const path = `${directory}/${name}`;
      const relativePath = relative === "" ? name : `${relative}/${name}`;
      const details = await options.filesystem.lstat(path);
      if (details.kind === "directory") {
        await visit(path, relativePath);
      } else if (details.kind === "symlink") {
        const target = await options.filesystem.readlink(path);
        if (namesLineage(Buffer.from(target), options.lineage)) {
          files.push({ kind: "link", relativePath });
        }
      } else if (details.kind === "file") {
        if (name.endsWith(WAL_SUFFIX)) await flushWal(options, path);
        else {
          const kind = await classify(options, path);
          if (kind !== undefined) files.push({ kind, relativePath });
        }
      }
    }
  };
  await visit(options.folder, "");
  return files;
}

async function flushWal(options: RecordOptions, wal: string): Promise<void> {
  if (options.sqlite === undefined) return;
  const database = wal.slice(0, -WAL_SUFFIX.length);
  try {
    const opened = await options.sqlite.open(database, { readOnly: false });
    try {
      opened.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      opened.close();
    }
  } catch (error: unknown) {
    options.logger?.warn(`could not flush ${database}: ${errorMessage(error)}`);
    return;
  }
  const left = await options.filesystem.stat(wal).then(
    (found) => found.size,
    (error: unknown) => {
      if (isMissingPathError(error)) return 0;
      throw error;
    },
  );
  if (left > 0) {
    options.logger?.warn(`WAL ${wal} still holds frames after the flush; left unpatched`);
  }
}

async function classify(
  options: RecordOptions,
  path: string,
): Promise<"file" | "unreadable" | undefined> {
  try {
    const names = await eachWindow(options.filesystem, path, (window) =>
      Promise.resolve(namesLineage(window, options.lineage)),
    );
    return names ? "file" : undefined;
  } catch (error: unknown) {
    options.logger?.warn(
      `could not read ${path} in source ${options.udid}: ${errorMessage(error)}; recorded as unreadable`,
    );
    return "unreadable";
  }
}

/** why: windows overlap by one UDID in UTF-16 less a byte, so a UDID spanning two reads is whole in one; `visit` answers true to stop. */
async function eachWindow(
  filesystem: Filesystem,
  path: string,
  visit: (window: Buffer, start: number) => Promise<boolean>,
): Promise<boolean> {
  const { size } = await filesystem.stat(path);
  for (let start = 0; start < size; start += WINDOW_BYTES) {
    const end = Math.min(start + WINDOW_BYTES + SWAP_OVERLAP_BYTES, size) - 1;
    if (await visit(await readRange(filesystem, path, start, end), start)) return true;
  }
  return false;
}

async function readRange(
  filesystem: Filesystem,
  path: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const file = await filesystem.openFile(path);
  const chunks: Uint8Array[] = [];
  const reader = file.read({ end, start }).getReader();
  for (;;) {
    const piece = await reader.read();
    if (piece.done) break;
    chunks.push(piece.value);
  }
  return Buffer.concat(chunks);
}

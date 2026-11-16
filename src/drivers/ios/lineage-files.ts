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

/** why: a window is read whole, so this bounds memory at any file size. */
const WINDOW_BYTES = 1_048_576;

const WAL_SUFFIX = "-wal";

export interface SwapCounts {
  readonly files: number;
  readonly links: number;
  readonly unreadable: number;
}

/** why: ADR 0076 §3: before its first boot a copy's recorded files and links name its own UDID in place of the lineage's, each keeping its length; an unreadable file is left. */
export async function swapCopyFiles(
  filesystem: Filesystem,
  folder: string,
  files: readonly SourceFile[],
  swap: LineageSwap,
): Promise<SwapCounts> {
  const counts = { files: 0, links: 0, unreadable: 0 };
  for (const file of files) {
    const path = `${folder}/${file.relativePath}`;
    if (file.kind === "unreadable") {
      counts.unreadable += 1;
    } else if (file.kind === "link") {
      counts.links += 1;
      const target = Buffer.from(await filesystem.readlink(path));
      const swapped = swapLineage(target, swap);
      checkLength(path, target, swapped);
      if (!target.equals(swapped)) {
        await filesystem.replaceSymlink(path, Buffer.from(swapped).toString());
      }
    } else {
      counts.files += 1;
      await eachWindow(filesystem, path, async (window, start) => {
        const swapped = swapLineage(window, swap);
        checkLength(path, window, swapped);
        if (!window.equals(swapped)) await filesystem.writeAt(path, start, swapped);
        return false;
      });
    }
  }
  return counts;
}

function checkLength(path: string, before: Uint8Array, after: Uint8Array): void {
  if (before.length !== after.length) {
    throw new DriverCrashError(`swapping UDIDs in ${path} changed its length`);
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
 * why: ADR 0076 §2: when a source is made every WAL in it is flushed into its database, and the files and links that name a lineage UDID are found once and recorded, so a copy patches only those.
 */
export async function recordLineageFiles(options: RecordOptions): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  await visitFolder(options, options.folder, "", files);
  return files;
}

async function visitFolder(
  options: RecordOptions,
  directory: string,
  relative: string,
  files: SourceFile[],
): Promise<void> {
  const names = (await options.filesystem.readdir(directory)).sort();
  // why: a database and its WAL are siblings, and a database is read only after its WAL is flushed into it (ADR 0076 §2).
  const ordered = [
    ...names.filter((name) => name.endsWith(WAL_SUFFIX)),
    ...names.filter((name) => !name.endsWith(WAL_SUFFIX)),
  ];
  for (const name of ordered) {
    const path = `${directory}/${name}`;
    const relativePath = relative === "" ? name : `${relative}/${name}`;
    const details = await options.filesystem.lstat(path);
    if (details.kind === "directory") {
      await visitFolder(options, path, relativePath, files);
      continue;
    }
    const kind = await recordedKind(options, path, details.kind);
    if (kind !== undefined) files.push({ kind, relativePath });
  }
}

/** why: a link is recorded when its target names the lineage; a WAL is flushed and never recorded; any other file is recorded when its bytes name it or cannot be read. */
async function recordedKind(
  options: RecordOptions,
  path: string,
  entry: string,
): Promise<SourceFile["kind"] | undefined> {
  if (entry === "symlink") {
    const target = await options.filesystem.readlink(path);
    return namesLineage(Buffer.from(target), options.lineage) ? "link" : undefined;
  }
  if (entry !== "file") return undefined;
  if (path.endsWith(WAL_SUFFIX)) {
    await flushWal(options, path);
    return undefined;
  }
  return classify(options, path);
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

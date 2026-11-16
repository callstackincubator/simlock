import { DriverCrashError } from "../../core/index.js";
import type { Filesystem } from "../../ports/index.js";
import type { SourceFile } from "./source-data.js";
import { SWAP_OVERLAP_BYTES, swapLineage, type LineageSwap } from "./udid-swap.js";

/** why: a window is read whole, so this bounds memory at any file size (ADR 0076 §3). */
const WINDOW_BYTES = 1_048_576;

/** why: ADR 0076 §4: before its first boot a copy's recorded files name its own UDID in place of the lineage's, each file keeping its length. */
export async function swapCopyFiles(
  filesystem: Filesystem,
  folder: string,
  files: readonly SourceFile[],
  swap: LineageSwap,
): Promise<void> {
  for (const file of files) {
    if (file.kind === "file") await swapFile(filesystem, `${folder}/${file.relativePath}`, swap);
  }
}

async function swapFile(filesystem: Filesystem, path: string, swap: LineageSwap): Promise<void> {
  const { size } = await filesystem.stat(path);
  for (let start = 0; start < size; start += WINDOW_BYTES) {
    const end = Math.min(start + WINDOW_BYTES + SWAP_OVERLAP_BYTES, size) - 1;
    const window = await readRange(filesystem, path, start, end);
    const swapped = swapLineage(window, swap);
    if (swapped.length !== window.length) {
      throw new DriverCrashError(`swapping UDIDs in ${path} changed its length`);
    }
    if (!Buffer.from(swapped).equals(window)) await filesystem.writeAt(path, start, swapped);
  }
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

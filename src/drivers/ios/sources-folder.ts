import { basename, dirname, join } from "node:path";

import type { Filesystem } from "../../ports/index.js";

const SOURCES_FOLDER_NAME = "src";

export interface SourcesFolderOptions {
  readonly deviceSet: string;
  readonly filesystem: Filesystem;
  readonly simlockHome: string;
}

/**
 * why: ADR 0076 §1: a copy's stored paths are patched byte for byte, so the folder the sources live in
 * has a real path exactly as long as the device set's: `src` followed by `_` to the needed length.
 */
export async function sourcesFolderFor(options: SourcesFolderOptions): Promise<string> {
  const home = await realPathOf(options.filesystem, options.simlockHome);
  const deviceSet = await realPathOf(options.filesystem, options.deviceSet);
  const base = join(home, "devices", SOURCES_FOLDER_NAME);
  return base + "_".repeat(Math.max(0, deviceSet.length - base.length));
}

/** why: Xcode's `Devices` folder or the other setting's root may not exist yet; its real path is its nearest existing parent's, joined with the rest. */
async function realPathOf(filesystem: Filesystem, path: string): Promise<string> {
  try {
    return await filesystem.realpath(path);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    if (dirname(path) === path) return path;
    return join(await realPathOf(filesystem, dirname(path)), basename(path));
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

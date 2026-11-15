import { basename, dirname, join } from "node:path";

import { OwnedRootError } from "../../core/index.js";
import type { Filesystem } from "../../ports/index.js";

const SOURCES_FOLDER_NAME = "src";

export interface SourcesFolderOptions {
  /** why: set only for `simlock` with a configured `deviceRoot`: the refusal names that key, where under `default` it names Xcode's set. */
  readonly configuredRoot?: string;
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
  refuseUnfit(options, home, deviceSet);
  return base + "_".repeat(Math.max(0, deviceSet.length - base.length));
}

function refuseUnfit(options: SourcesFolderOptions, home: string, deviceSet: string): void {
  const room = Math.max(0, deviceSet.length - join(home, "devices").length - 1);
  const tooShort = `${home}/devices/ leaves ${String(room)} characters for its name, fewer than 3`;
  const length = String(deviceSet.length);
  const fitsLength = room >= SOURCES_FOLDER_NAME.length;

  if (options.configuredRoot === undefined) {
    if (isUnderPrivate(home) && !isUnderPrivate(deviceSet)) {
      throw unfit(
        deviceSet,
        `${home} is under /private, where iOS stores each path in two spellings, but Xcode's set ${deviceSet} is not. Set SIMLOCK_HOME to a folder outside /tmp and /var.`,
      );
    }
    if (!fitsLength) {
      throw unfit(
        deviceSet,
        `the sources folder must have a path as long as ${deviceSet} (${length} characters), but ${tooShort}. Set SIMLOCK_HOME to a folder whose real path is at most ${String(deviceSet.length - 12)} characters.`,
      );
    }
    return;
  }

  const split = isUnderPrivate(home) !== isUnderPrivate(deviceSet);
  if (split || !fitsLength) {
    const cause = split
      ? `only one of ${options.configuredRoot} and ${home} is under /private`
      : tooShort;
    throw unfit(
      deviceSet,
      `the sources folder must have a path as long as drivers.ios.deviceRoot ${options.configuredRoot} (${length} characters), but ${cause}. Remove drivers.ios.deviceRoot, or set it to a path of at least ${String(home.length + 12)} characters that is under /private only when SIMLOCK_HOME is.`,
    );
  }
}

function unfit(deviceSet: string, explanation: string): OwnedRootError {
  return new OwnedRootError(
    `Refusing the ios device set: ${explanation}`,
    "sources-path-unfit",
    deviceSet,
    "ios",
  );
}

function isUnderPrivate(path: string): boolean {
  return path === "/private" || path.startsWith("/private/");
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

export interface SourcesFolderContext {
  readonly driverConfig: Readonly<Record<string, unknown>>;
  readonly filesystem: Filesystem;
  readonly simlockHome: string;
}

/** why: `configured` is true only for `simlock`, where a `deviceRoot` the operator set is what the refusal names. */
export function sourcesFolderOf(
  options: SourcesFolderContext,
  deviceSet: string,
  configured = false,
): Promise<string> {
  const root = options.driverConfig["deviceRoot"];
  return sourcesFolderFor({
    ...(configured && typeof root === "string" ? { configuredRoot: root } : {}),
    deviceSet,
    filesystem: options.filesystem,
    simlockHome: options.simlockHome,
  });
}

/** why: the other setting's sources folder only matters when it can exist: where its length is unfit, nothing was ever made there, and it is read to nothing. */
export async function fitSourcesFolders(
  options: SourcesFolderContext,
  deviceSet: string,
): Promise<readonly string[]> {
  try {
    return [await sourcesFolderOf(options, deviceSet)];
  } catch {
    // why: a set that cannot be measured is one the check reads anyway, and reports as unreadable.
    return [];
  }
}

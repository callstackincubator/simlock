import { join } from "node:path";

import { OwnedRootError } from "../../core/index.js";
import type { Filesystem } from "../../ports/index.js";

export const UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const MARK_FILE_NAME = "simlock-mark.json";

const SWITCH_STEPS =
  "run `simlock nuke --delete-devices` and `simlock doctor --purge-orphans`, then switch again.";

/**
 * why: Switching `drivers.ios.deviceSet` with simulators left in the set being given up would
 * leave them invisible to the new setting, so the driver refuses to start. The
 * check reads files only: a start-up `simctl` call would be a new way for start-up to hang.
 */
export async function refuseOwnSetLeftovers(filesystem: Filesystem, root: string): Promise<void> {
  // why: the sources set of `deviceSet: simlock` is the `sources` folder of the set; its seeds are as invisible to `default` as the set's devices.
  const entries = [
    ...(await readFolder(filesystem, root)),
    ...(await readFolder(filesystem, join(root, "sources"))),
  ];
  const udids = entries.filter((entry) => UDID_PATTERN.test(entry)).sort();
  if (udids.length === 0) return;

  throw new OwnedRootError(
    `Refusing the ios device set: Simlock's own set at ${root} still holds ${String(udids.length)} simulator(s) (${udids.join(", ")}). Set drivers.ios.deviceSet back to simlock, ${SWITCH_STEPS} Delete any that remain with \`xcrun simctl --set ${root} delete <udid>\`.`,
    "device-set-changed",
    root,
    "ios",
  );
}

/** why: the sources set of `deviceSet: default` is its own folder, which `simlock` never reads, so seeds left there are refused like devices. */
export async function refuseDefaultSourcesLeftovers(
  filesystem: Filesystem,
  sourcesSet: string,
): Promise<void> {
  const udids = (await readFolder(filesystem, sourcesSet))
    .filter((entry) => UDID_PATTERN.test(entry))
    .sort();
  if (udids.length === 0) return;

  throw new OwnedRootError(
    `Refusing the ios device set: Simlock's sources set at ${sourcesSet} still holds ${String(udids.length)} simulator(s) (${udids.join(", ")}). Set drivers.ios.deviceSet back to default, ${SWITCH_STEPS} Delete any that remain with \`xcrun simctl --set ${sourcesSet} delete <udid>\`.`,
    "device-set-changed",
    sourcesSet,
    "ios",
  );
}

export async function refuseXcodeSetLeftovers(
  filesystem: Filesystem,
  devicesDir: string,
  instanceId: string,
): Promise<void> {
  const entries = await readFolder(filesystem, devicesDir);
  const marked: string[] = [];
  for (const entry of entries.sort()) {
    if (await marksInstance(filesystem, join(devicesDir, entry, MARK_FILE_NAME), instanceId)) {
      marked.push(entry);
    }
  }
  if (marked.length === 0) return;

  throw new OwnedRootError(
    `Refusing the ios device set: Xcode's device set still holds ${String(marked.length)} of this Simlock's simulator(s) (${marked.join(", ")}). Set drivers.ios.deviceSet back to default, ${SWITCH_STEPS} Delete any that remain with \`xcrun simctl delete <udid>\`.`,
    "device-set-changed",
    devicesDir,
    "ios",
  );
}

async function readFolder(filesystem: Filesystem, folder: string): Promise<string[]> {
  try {
    return await filesystem.readdir(folder);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw new OwnedRootError(
      `Refusing the ios device set: ${folder} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      "unreadable",
      folder,
      "ios",
    );
  }
}

async function marksInstance(
  filesystem: Filesystem,
  markPath: string,
  instanceId: string,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await filesystem.readFile(markPath)) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "instanceId" in parsed &&
      parsed.instanceId === instanceId
    );
  } catch {
    // why: A mark that is missing, unreadable or corrupt proves no instance, so it is not ours.
    return false;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

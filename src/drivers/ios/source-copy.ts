import { join } from "node:path";

import { DriverCrashError } from "../../core/index.js";
import type { Clock, Filesystem } from "../../ports/index.js";
import { swapForeignFolders } from "./foreign-folders.js";
import type { SourceFile } from "./source-data.js";
import type { SourceIndexOptions } from "./source-index.js";

export const OVERRIDES_FILE_NAME = "disabled.plist";
const LAUNCH_SERVICES_DATABASE = /^com\.apple\.LaunchServices-.*\.csstore$/;

export interface CopyContext extends SourceIndexOptions {
  readonly clock: Clock;
}

/**
 * why: `simctl clone` keeps the LaunchServices database, which records each app (system apps
 * included) by its absolute path under the original device's folder; a copy then uses the
 * original's data, or fails once that folder is gone. Dropped from every clone before its first
 * boot, LaunchServices rebuilds it from the clone's own container folders (ADR 0061 §3).
 */
export async function dropLaunchServicesDatabase(
  filesystem: Filesystem,
  setPath: string,
  udid: string,
): Promise<void> {
  const folder = join(setPath, udid, "data", "var", "db", "lsd");
  if (!(await filesystem.exists(folder))) return;
  for (const entry of await filesystem.readdir(folder)) {
    if (LAUNCH_SERVICES_DATABASE.test(entry)) await filesystem.rm(join(folder, entry));
  }
}

/**
 * why: ADR 0076 §3: a copy's files and links still name its source's device and log folders, and
 * the copy would write into them; before its first boot each recorded one names the copy's own
 * (a swap of the same length, so no format is parsed). A copy whose swap fails is deleted by the caller.
 */
export async function swapCopyFolders(
  context: CopyContext,
  recorded: readonly SourceFile[],
  copyUdid: string,
): Promise<void> {
  const { filesystem, folders } = context;
  const startedAt = context.clock.now();
  let files = 0;
  let links = 0;
  for (const file of recorded) {
    const path = join(folders.deviceSet, copyUdid, file.relativePath);
    const before =
      file.kind === "link"
        ? Buffer.from(await filesystem.readlink(path))
        : await filesystem.readBytes(path);
    const after = swapForeignFolders(before, { ...folders, ownUdid: copyUdid });
    if (after.length !== before.length) {
      throw new DriverCrashError(`swapping the folders in ${path} would change its length`);
    }
    if (Buffer.compare(before, after) === 0) continue;
    if (file.kind === "link") {
      await filesystem.replaceSymlink(path, Buffer.from(after).toString());
      links += 1;
    } else {
      await filesystem.overwriteSameLength(path, after);
      files += 1;
    }
  }
  context.logger?.debug(
    `swapped ${String(files)} files and ${String(links)} links in ${String(context.clock.now() - startedAt)} ms for ${copyUdid}`,
  );
}

/** why: ADR 0060 §1: the slim file is in place before the copy's first boot, so the copy boots with what the seed was given. */
export async function copyOverrides(
  context: Pick<CopyContext, "filesystem" | "logger">,
  folderOf: (udid: string) => string,
  seedUdid: string,
  copyUdid: string,
): Promise<void> {
  const { filesystem } = context;
  const from = join(folderOf(seedUdid), OVERRIDES_FILE_NAME);
  try {
    if (!(await filesystem.exists(from))) return;
    await filesystem.mkdirp(folderOf(copyUdid), { mode: 0o700 });
    await filesystem.copyFile(from, join(folderOf(copyUdid), OVERRIDES_FILE_NAME));
  } catch (error: unknown) {
    context.logger?.warn(
      `could not copy the launchd overrides of seed ${seedUdid} to ${copyUdid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

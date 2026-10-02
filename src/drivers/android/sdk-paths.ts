import type { Filesystem } from "../../ports/index.js";

/**
 * Where each Android SDK tool lives. Driver discovery and the `doctor` prerequisite check both
 * ask this file, so the two can never disagree about whether a tool is there (architecture
 * rule 10).
 */
export interface AndroidSdkPaths {
  readonly adb: string;
  readonly avdmanager: string;
  readonly emulator: string;
  readonly root: string;
  readonly sdkmanager: string;
}

/** The SDK roots searched, in order: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then Android Studio's default. */
export function sdkSearchRoots(
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string[] {
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, `${homeDirectory}/Library/Android/sdk`].filter(
    (root): root is string => root !== undefined && root !== "",
  );
}

export function emulatorPath(root: string): string {
  return `${root}/emulator/emulator`;
}

export function adbPath(root: string): string {
  return `${root}/platform-tools/adb`;
}

/** Every tool the driver runs, when all of them are at `root`; otherwise `undefined`. */
export async function sdkPathsAt(
  root: string,
  filesystem: Filesystem,
): Promise<AndroidSdkPaths | undefined> {
  const tools = await sdkToolBin(root, filesystem);
  const emulator = emulatorPath(root);
  const adb = adbPath(root);
  if (
    tools === undefined ||
    !(await filesystem.exists(emulator)) ||
    !(await filesystem.exists(adb))
  ) {
    return undefined;
  }
  return { adb, emulator, root, ...tools };
}

/**
 * The newest `cmdline-tools/<version>/bin` holding both `avdmanager` and `sdkmanager`, or the
 * obsolete `tools/bin` when none does.
 */
export async function sdkToolBin(
  root: string,
  filesystem: Filesystem,
): Promise<Pick<AndroidSdkPaths, "avdmanager" | "sdkmanager"> | undefined> {
  const bins = [...(await commandLineToolBins(root, filesystem)), `${root}/tools/bin`];
  for (const bin of bins) {
    const avdmanager = `${bin}/avdmanager`;
    const sdkmanager = `${bin}/sdkmanager`;
    if ((await filesystem.exists(avdmanager)) && (await filesystem.exists(sdkmanager))) {
      return { avdmanager, sdkmanager };
    }
  }
  return undefined;
}

async function commandLineToolBins(root: string, filesystem: Filesystem): Promise<string[]> {
  const toolsRoot = `${root}/cmdline-tools`;
  if (!(await filesystem.exists(toolsRoot))) {
    return [];
  }

  const directories = await filesystem.readdir(toolsRoot);
  return directories
    .sort(compareCommandLineToolVersions)
    .reverse()
    .map((directory) => `${toolsRoot}/${directory}/bin`);
}

function compareCommandLineToolVersions(left: string, right: string): number {
  if (left === "latest") {
    return 1;
  }
  if (right === "latest") {
    return -1;
  }

  const leftSegments = left.split(".").map(Number);
  const rightSegments = right.split(".").map(Number);
  if (leftSegments.every(Number.isFinite) && rightSegments.every(Number.isFinite)) {
    const length = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftSegments[index] ?? 0) - (rightSegments[index] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
  }

  return left.localeCompare(right);
}

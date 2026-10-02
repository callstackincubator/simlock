import type { MissingPrerequisite, PrerequisiteCheck } from "../../core/driver.js";
import type { Filesystem, ProcessRunner } from "../../ports/index.js";
import { adbPath, emulatorPath, locateSdk, sdkToolBin } from "./sdk-paths.js";

const SDKMANAGER_TIMEOUT_MS = 30_000;
const COMMAND_LINE_TOOLS_PAGE = "https://developer.android.com/studio#command-line-tools-only";

interface AndroidPrerequisitesOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  readonly processRunner: ProcessRunner;
}

/**
 * What the Android driver needs and Simlock never installs: an SDK with `cmdline-tools`,
 * `emulator` and `platform-tools`, and a JDK `sdkmanager` can run on. Looks where driver
 * discovery looks, through the same functions, and starts no process but `sdkmanager --version`.
 */
export function androidPrerequisites(options: AndroidPrerequisitesOptions): PrerequisiteCheck {
  return {
    check: () => missingAndroidPrerequisites(options),
    platform: "android",
  };
}

async function missingAndroidPrerequisites(
  options: AndroidPrerequisitesOptions,
): Promise<readonly MissingPrerequisite[]> {
  const location = await locateSdk(options.env, options.homeDirectory, options.filesystem);
  if (location.kind === "absent") {
    // One finding, not one per tool: with no SDK at all, every tool is missing for the same reason.
    return [
      {
        message: `No Android SDK found; searched: ${location.searched.join(", ")}.`,
        prerequisite: "android-sdk",
        remedy:
          "Install Android Studio (https://developer.android.com/studio), or the command-line " +
          `tools (${COMMAND_LINE_TOOLS_PAGE}), and set ANDROID_HOME to the SDK directory.`,
      },
    ];
  }

  // The SDK discovery runs, when it found one; otherwise the first root there is.
  const root = location.kind === "complete" ? location.paths.root : location.root;
  const missing: MissingPrerequisite[] = [];
  const tools = await sdkToolBin(root, options.filesystem);
  if (tools === undefined) {
    missing.push({
      message: `The Android SDK command-line tools (sdkmanager, avdmanager) are not in ${root}.`,
      prerequisite: "android-cmdline-tools",
      remedy:
        `Download the command-line tools from ${COMMAND_LINE_TOOLS_PAGE} and unpack them to ` +
        `${root}/cmdline-tools/latest; sdkmanager cannot install itself.`,
    });
  }
  if (!(await options.filesystem.exists(emulatorPath(root)))) {
    missing.push({
      message: `The Android emulator package is not installed in ${root}.`,
      prerequisite: "android-emulator",
      remedy: "Run `sdkmanager --install emulator`.",
    });
  }
  if (!(await options.filesystem.exists(adbPath(root)))) {
    missing.push({
      message: `The Android platform-tools package (adb) is not installed in ${root}.`,
      prerequisite: "android-platform-tools",
      remedy: "Run `sdkmanager --install platform-tools`.",
    });
  }
  if (tools !== undefined) {
    const jdk = await missingJdk(options.processRunner, tools.sdkmanager);
    if (jdk !== undefined) missing.push(jdk);
  }
  return missing;
}

/**
 * `sdkmanager` is a Java program, so a failing `--version` is how a missing or unusable JDK
 * shows. A run the timeout ended (`null` exit code) says nothing about the JDK and rejects.
 */
async function missingJdk(
  processRunner: ProcessRunner,
  sdkmanager: string,
): Promise<MissingPrerequisite | undefined> {
  const result = await processRunner.run(sdkmanager, ["--version"], {
    timeoutMs: SDKMANAGER_TIMEOUT_MS,
  });
  if (result.code === null) {
    throw new Error(`${sdkmanager} --version did not finish within ${SDKMANAGER_TIMEOUT_MS}ms`);
  }
  if (result.code === 0) return undefined;
  const firstLine = result.stderr
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  return {
    message: `sdkmanager cannot run${firstLine === undefined ? "" : `: ${firstLine}`}`,
    prerequisite: "android-jdk",
    remedy: "Install a JDK and set JAVA_HOME to it.",
  };
}

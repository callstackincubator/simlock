import type { MissingPrerequisite, PrerequisiteCheck } from "../../core/index.js";
import { ProcessSpawnError, type ProcessResult, type ProcessRunner } from "../../ports/index.js";

const XCODEBUILD_TIMEOUT_MS = 15_000;

const XCODE: MissingPrerequisite = {
  message: "Xcode is not installed, or is not the selected developer directory.",
  prerequisite: "xcode",
  remedy: "Install Xcode, then run `sudo xcode-select -s /Applications/Xcode.app`.",
};

const XCODE_LICENSE: MissingPrerequisite = {
  message: "The Xcode license is not accepted.",
  prerequisite: "xcode-license",
  remedy: "Run `sudo xcodebuild -license accept`.",
};

const XCODE_FIRST_LAUNCH: MissingPrerequisite = {
  message: "Xcode's first-launch setup has not run.",
  prerequisite: "xcode-first-launch",
  remedy: "Run `sudo xcodebuild -runFirstLaunch`.",
};

/**
 * What the iOS driver needs and Simlock never installs: a selected Xcode whose license is
 * accepted and whose first-launch setup is done. Runs `xcodebuild` and nothing else.
 */
export function iosPrerequisites(options: {
  readonly processRunner: ProcessRunner;
}): PrerequisiteCheck {
  return {
    check: () => missingIosPrerequisites(options.processRunner),
    platform: "ios",
  };
}

async function missingIosPrerequisites(
  processRunner: ProcessRunner,
): Promise<readonly MissingPrerequisite[]> {
  let version: ProcessResult;
  try {
    version = await xcodebuild(processRunner, ["-version"]);
  } catch (error: unknown) {
    if (error instanceof ProcessSpawnError) return [XCODE];
    throw error;
  }
  if (version.code !== 0) {
    // The same test `toolVersions` makes: the command line tools' `xcodebuild` refuses to run
    // without Xcode. Any other failure is something this check cannot read, so it says nothing.
    if (/requires Xcode/.test(version.stderr)) return [XCODE];
    throw new Error(`xcodebuild -version exited with ${String(version.code)}`);
  }

  const missing: MissingPrerequisite[] = [];
  if ((await xcodebuild(processRunner, ["-license", "check"])).code !== 0) {
    missing.push(XCODE_LICENSE);
  }
  if ((await xcodebuild(processRunner, ["-checkFirstLaunchStatus"])).code !== 0) {
    missing.push(XCODE_FIRST_LAUNCH);
  }
  return missing;
}

/**
 * One bounded `xcodebuild` run. A `null` exit code means a signal ended the process, which is
 * how the runner ends one that ran out of time: that is "could not tell", not "missing".
 */
async function xcodebuild(
  processRunner: ProcessRunner,
  args: readonly string[],
): Promise<ProcessResult> {
  const result = await processRunner.run("xcodebuild", args, { timeoutMs: XCODEBUILD_TIMEOUT_MS });
  if (result.code === null) {
    throw new Error(
      `xcodebuild ${args.join(" ")} did not finish within ${XCODEBUILD_TIMEOUT_MS}ms`,
    );
  }
  return result;
}

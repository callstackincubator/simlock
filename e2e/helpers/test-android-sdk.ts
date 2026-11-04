import { homedir } from "node:os";

import { type AndroidSdkPaths, locateSdk } from "../../src/drivers/android/testing.js";
import { type Filesystem, NodeFilesystem, NodeProcessRunner } from "../../src/ports/index.js";

const runner = new NodeProcessRunner();

/**
 * why: the slow Android tests skip exactly when the real driver could not start, so they ask the
 * driver's own `locateSdk` (which knows `%LOCALAPPDATA%` and the `.exe`/`.bat` tools on Windows)
 * rather than a lookup of their own that silently skips on a host it does not know.
 */
export async function findAndroidSdk(
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  filesystem: Filesystem,
  platform: NodeJS.Platform,
): Promise<AndroidSdkPaths | undefined> {
  const location = await locateSdk(env, homeDirectory, filesystem, platform);
  return location.kind === "complete" ? location.paths : undefined;
}

export const ANDROID_SDK: AndroidSdkPaths | undefined = await findAndroidSdk(
  process.env,
  homedir(),
  new NodeFilesystem(),
  process.platform,
);

export function requireAndroidSdk(): AndroidSdkPaths {
  if (ANDROID_SDK === undefined) {
    throw new Error("no complete Android SDK on this host: the test should have been skipped");
  }
  return ANDROID_SDK;
}

/**
 * why: a `.bat` tool (`avdmanager` on Windows) runs through the ports' process runner, which owns
 * how a batch file runs under cmd.exe and which arguments it refuses. As `execFile` did, a non-zero
 * exit rejects, and a run its timeout ended rejects with `killed: true`.
 */
export async function runSdkTool(
  tool: string,
  args: readonly string[],
  options: { readonly timeout?: number } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runner.run(
    tool,
    args,
    options.timeout === undefined ? {} : { timeoutMs: options.timeout },
  );
  if (result.code === 0) return result;
  throw Object.assign(
    new Error(`${tool} ${args.join(" ")} exited ${String(result.code)}: ${result.stderr}`),
    { killed: result.code === null },
  );
}

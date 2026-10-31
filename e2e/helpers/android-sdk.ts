import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { type AndroidSdkPaths, locateSdk } from "../../src/drivers/android/index.js";
import { type Filesystem, NodeFilesystem } from "../../src/ports/index.js";

const execFileAsync = promisify(execFile);

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

/** why: `%` and `!` expand and `"` ends the quoting inside cmd.exe, so no quoting makes them literal. */
const CMD_UNSAFE = /["%!\r\n]/;

/**
 * why: Node refuses to run a `.bat` without a shell, so on Windows one goes through cmd.exe with
 * the tool and every argument quoted, and an argument cmd.exe would still expand is refused.
 */
export function sdkToolInvocation(
  tool: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { readonly file: string; readonly args: readonly string[]; readonly shell: boolean } {
  if (platform !== "win32" || !tool.toLowerCase().endsWith(".bat")) {
    return { args, file: tool, shell: false };
  }
  const unsafe = [tool, ...args].find((part) => CMD_UNSAFE.test(part));
  if (unsafe !== undefined) {
    throw new Error(`cannot pass ${JSON.stringify(unsafe)} to a .bat through cmd.exe`);
  }
  return { args: args.map((arg) => `"${arg}"`), file: `"${tool}"`, shell: true };
}

export async function runSdkTool(
  tool: string,
  args: readonly string[],
  options: { readonly timeout?: number } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const invocation = sdkToolInvocation(tool, args, process.platform);
  return execFileAsync(invocation.file, invocation.args, {
    shell: invocation.shell,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}

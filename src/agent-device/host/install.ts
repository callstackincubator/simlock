import { dirname, win32 } from "node:path";

import { type Filesystem } from "../../ports/index.js";

export type AgentDeviceInstall =
  | { readonly ok: true; readonly realPath: string; readonly entry: string }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "not-agent-device";
      readonly message: string;
    };

// why: Windows has no execute bit; Node reports a file there as 0o666 (0o444 when read-only), so any file counts.
async function isExecutableFile(
  filesystem: Filesystem,
  path: string,
  windows: boolean,
): Promise<boolean> {
  try {
    const details = await filesystem.stat(path);
    return details.kind === "file" && (windows || ((details.mode ?? 0) & 0o111) !== 0);
  } catch {
    return false;
  }
}

const SHIM_SUFFIX = /\.cmd$/i;

/**
 * why: npm on Windows installs a `<command>.cmd` shim, not a symlink. `node` cannot run the shim,
 * and its real path is itself, so the package's own `bin` file stands in for it: `--version` runs
 * it, and the package root is above it. A configured name or path may already end in `.cmd`.
 */
async function npmShimTarget(
  filesystem: Filesystem,
  directory: string,
  command: string,
): Promise<string | undefined> {
  const name = command.replace(SHIM_SUFFIX, "");
  const shimDirectory = directory.replace(/[\\/]+$/, "");
  if (!(await isExecutableFile(filesystem, `${shimDirectory}/${name}.cmd`, true))) return undefined;
  return packageBin(filesystem, packageRootBeside(shimDirectory, name), name);
}

// why: a global install puts its shims beside `node_modules`; a local one puts them in `node_modules/.bin`, beside the package.
function packageRootBeside(shimDirectory: string, name: string): string {
  return /(^|[\\/])node_modules[\\/]\.bin$/i.test(shimDirectory)
    ? `${win32.dirname(shimDirectory)}/${name}`
    : `${shimDirectory}/node_modules/${name}`;
}

async function packageBin(
  filesystem: Filesystem,
  packageRoot: string,
  name: string,
): Promise<string | undefined> {
  try {
    const { bin } = JSON.parse(await filesystem.readFile(`${packageRoot}/package.json`)) as {
      bin?: unknown;
    };
    const relative =
      typeof bin === "string" ? bin : (bin as Record<string, unknown> | undefined)?.[name];
    if (typeof relative !== "string") return undefined;
    const target = `${packageRoot}/${relative.replace(/^\.\//, "")}`;
    return (await isExecutableFile(filesystem, target, true)) ? target : undefined;
  } catch {
    return undefined;
  }
}

function isPath(command: string, windows: boolean): boolean {
  return command.includes("/") || (windows && command.includes("\\"));
}

async function locatePath(
  filesystem: Filesystem,
  command: string,
  windows: boolean,
): Promise<string | undefined> {
  if (windows && SHIM_SUFFIX.test(command)) {
    return npmShimTarget(filesystem, win32.dirname(command), win32.basename(command));
  }
  return (await isExecutableFile(filesystem, command, windows)) ? command : undefined;
}

async function executableIn(
  filesystem: Filesystem,
  directory: string,
  command: string,
): Promise<string | undefined> {
  const candidate = `${directory}/${command}`;
  return (await isExecutableFile(filesystem, candidate, false)) ? candidate : undefined;
}

async function locate(
  filesystem: Filesystem,
  command: string,
  pathVariable: string | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const windows = platform === "win32";
  if (isPath(command, windows)) return locatePath(filesystem, command, windows);
  const lookIn = windows ? npmShimTarget : executableIn;
  // why: Windows separates PATH entries with `;`, and its drive letters hold a `:`.
  for (const directory of (pathVariable ?? "").split(windows ? ";" : ":")) {
    if (directory === "") continue;
    const candidate = await lookIn(filesystem, directory, command);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/** why: on Windows the variable is `Path`, and a copy of `process.env` loses its case-insensitive lookup. */
export function pathVariableOf(environment: NodeJS.ProcessEnv): string | undefined {
  return (
    environment["PATH"] ??
    Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1]
  );
}

export async function findAgentDevice(
  filesystem: Filesystem,
  command: string,
  pathVariable: string | undefined,
  platform: NodeJS.Platform,
): Promise<AgentDeviceInstall> {
  const found = await locate(filesystem, command, pathVariable, platform);
  const notFound = {
    ok: false,
    reason: "not-found",
    message: isPath(command, platform === "win32")
      ? `agent-device not found: ${command} is not an executable file`
      : `agent-device not found: "${command}" is not on PATH`,
  } as const;
  if (found === undefined) return notFound;

  let realPath: string;
  try {
    realPath = await filesystem.realpath(found);
  } catch {
    return notFound;
  }

  const packageRoot = dirname(dirname(realPath));
  const notAgentDevice = (message: string) =>
    ({ ok: false, reason: "not-agent-device", message }) as const;
  let packageName: unknown;
  try {
    packageName = (
      JSON.parse(await filesystem.readFile(`${packageRoot}/package.json`)) as { name?: unknown }
    ).name;
  } catch {
    return notAgentDevice(`${packageRoot}/package.json is missing or unreadable`);
  }
  if (packageName !== "agent-device") {
    return notAgentDevice(`${packageRoot}/package.json does not name agent-device`);
  }

  for (const entry of [
    `${packageRoot}/dist/src/internal/daemon.js`,
    `${packageRoot}/dist/src/daemon.js`,
  ]) {
    if (await filesystem.exists(entry)) return { ok: true, realPath, entry };
  }
  return notAgentDevice(`${packageRoot} has no agent-device daemon entry under dist/src`);
}

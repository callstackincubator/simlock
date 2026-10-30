import { dirname } from "node:path";

import { type Filesystem } from "../../ports/index.js";

export type AgentDeviceInstall =
  | { readonly ok: true; readonly realPath: string; readonly entry: string }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "not-agent-device";
      readonly message: string;
    };

// why: Windows has no execute bit; Node reports every file there as 0o666, so any file counts.
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

/**
 * why: npm on Windows installs a `<command>.cmd` shim, not a symlink, with the package beside it
 * in `node_modules/<command>`. `node` cannot run the shim, and its real path is itself, so the
 * package's own `bin` file stands in for it: `--version` runs it, and the package root is above it.
 */
async function npmShimTarget(
  filesystem: Filesystem,
  directory: string,
  command: string,
): Promise<string | undefined> {
  if (!(await isExecutableFile(filesystem, `${directory}/${command}.cmd`, true))) return undefined;
  const packageRoot = `${directory}/node_modules/${command}`;
  try {
    const { bin } = JSON.parse(await filesystem.readFile(`${packageRoot}/package.json`)) as {
      bin?: unknown;
    };
    const relative =
      typeof bin === "string" ? bin : (bin as Record<string, unknown> | undefined)?.[command];
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

async function locate(
  filesystem: Filesystem,
  command: string,
  pathVariable: string | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const windows = platform === "win32";
  if (isPath(command, windows)) {
    return (await isExecutableFile(filesystem, command, windows)) ? command : undefined;
  }
  // why: Windows separates PATH entries with `;`, and its drive letters hold a `:`.
  for (const directory of (pathVariable ?? "").split(windows ? ";" : ":")) {
    if (directory === "") continue;
    const candidate = windows
      ? await npmShimTarget(filesystem, directory, command)
      : (await isExecutableFile(filesystem, `${directory}/${command}`, false))
        ? `${directory}/${command}`
        : undefined;
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
  platform: NodeJS.Platform = process.platform,
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

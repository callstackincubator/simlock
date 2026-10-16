import { dirname } from "node:path";

import { type Filesystem } from "../../ports/index.js";

export type AgentDeviceInstall =
  | { readonly ok: true; readonly realPath: string; readonly entry: string }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "not-agent-device";
      readonly message: string;
    };

async function isExecutableFile(filesystem: Filesystem, path: string): Promise<boolean> {
  try {
    const details = await filesystem.stat(path);
    return details.kind === "file" && ((details.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function locate(
  filesystem: Filesystem,
  command: string,
  pathVariable: string | undefined,
): Promise<string | undefined> {
  if (command.includes("/")) {
    return (await isExecutableFile(filesystem, command)) ? command : undefined;
  }
  for (const directory of (pathVariable ?? "").split(":")) {
    if (directory === "") continue;
    const candidate = `${directory}/${command}`;
    if (await isExecutableFile(filesystem, candidate)) return candidate;
  }
  return undefined;
}

export async function findAgentDevice(
  filesystem: Filesystem,
  command: string,
  pathVariable: string | undefined,
): Promise<AgentDeviceInstall> {
  const found = await locate(filesystem, command, pathVariable);
  const notFound = {
    ok: false,
    reason: "not-found",
    message: command.includes("/")
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

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Filesystem } from "./filesystem.js";

/**
 * Resolves simlock's data directory (config.json, state.json, daemon.sock, daemon.log,
 * and the device roots under `devices/`). `SIMLOCK_HOME` overrides the default
 * `~/.simlock` -- used by tests that need an isolated data directory per daemon instance,
 * and by anyone running multiple independent simlock installs on one machine.
 *
 * A relative `SIMLOCK_HOME` is resolved here, once, against the process that read it.
 * Everything else derived from it would otherwise appear to work -- Node resolves a
 * relative path against the cwd on every call -- while the device root derived from it
 * would be refused `not-absolute`, silently costing a platform for a reason nobody is
 * looking at. It also means the daemon and the CLI that auto-launched it agree on one
 * directory even if they are standing somewhere different.
 */
export function resolveSimlockHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SIMLOCK_HOME;
  return configured === undefined ? join(homedir(), ".simlock") : resolve(configured);
}

/**
 * The longest AF_UNIX socket path the kernel accepts, in bytes, excluding the trailing
 * NUL: `sun_path` is 104 bytes on macOS and the BSDs and 108 on Linux. Windows named
 * pipes have no such limit.
 */
function maxSocketPathLength(platform: NodeJS.Platform = process.platform): number {
  if (platform === "win32") return Number.POSITIVE_INFINITY;
  return (platform === "linux" ? 108 : 104) - 1;
}

/** A `SIMLOCK_HOME` so deep that no socket can be bound or connected under it. */
export class SocketPathTooLongError extends Error {
  constructor(
    readonly path: string,
    readonly maxLength: number,
  ) {
    super(
      `Daemon socket path is ${Buffer.byteLength(path)} bytes, but this platform allows at most ${maxLength}: ${path}. ` +
        `Point SIMLOCK_HOME at a shorter directory.`,
    );
    this.name = "SocketPathTooLongError";
  }
}

/**
 * Where the daemon listens under a data directory. Checked here, once, for every process
 * that derives it: a path past the kernel's limit otherwise fails on connect as a bare
 * `EINVAL`, which says nothing about `SIMLOCK_HOME` being the cause.
 */
export function resolveDaemonSocketPath(
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const socketPath = join(dataDirectory, "daemon.sock");
  const maxLength = maxSocketPathLength(platform);
  if (Buffer.byteLength(socketPath) > maxLength) {
    throw new SocketPathTooLongError(socketPath, maxLength);
  }
  return socketPath;
}

export type DaemonRole = "worker" | "gateway";

export type DaemonFlag = "gateway" | "local" | undefined;

export interface DaemonHome {
  readonly role: DaemonRole;
  readonly dataDirectory: string;
  readonly gatewayPresent: boolean;
}

export function daemonDataDirectory(root: string, role: DaemonRole): string {
  return role === "gateway" ? join(root, "gateway") : root;
}

/** why: `exists` treats only a missing path as absent; a root whose `gateway` is a file is just as absent. */
async function existsOrAbsent(
  filesystem: Pick<Filesystem, "exists">,
  path: string,
): Promise<boolean> {
  try {
    return await filesystem.exists(path);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOTDIR"
    ) {
      return false;
    }
    throw error;
  }
}

// why: the one place the folder choice lives (ADR 0034); the daemon never calls it, it derives its folder from its role.
export async function resolveDaemonHome({
  filesystem,
  flag,
  root,
}: {
  readonly root: string;
  readonly flag: DaemonFlag;
  readonly filesystem: Pick<Filesystem, "exists">;
}): Promise<DaemonHome> {
  const gatewayFolder = daemonDataDirectory(root, "gateway");
  const gatewayPresent =
    (await existsOrAbsent(filesystem, join(gatewayFolder, "instance.json"))) ||
    (await existsOrAbsent(filesystem, join(gatewayFolder, "config.json")));
  const role: DaemonRole =
    flag === "gateway" ||
    (flag === undefined &&
      gatewayPresent &&
      !(await existsOrAbsent(filesystem, join(root, "instance.json"))))
      ? "gateway"
      : "worker";
  return { role, dataDirectory: daemonDataDirectory(root, role), gatewayPresent };
}

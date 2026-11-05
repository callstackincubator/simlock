import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../bus/index.js";
import { type EventHistoryHandle } from "../history/index.js";
import {
  type Clock,
  type DaemonRole,
  type Filesystem,
  type IpcConnector,
  type IpcListenerFactory,
  type Logger,
  type NpmCli,
  NodeUpdaterLauncher,
  daemonDataDirectory,
  resolveDaemonSocketPath,
  resolveSimlockHome,
} from "../ports/index.js";
import { socketHeld } from "../updater/index.js";
import { type UpdateCoordinatorOptions } from "./update-coordinator.js";
import { type VersionCheck } from "./version-check.js";

export interface UpdateOptionsParts {
  readonly clock: Clock;
  readonly dataDirectory: string;
  readonly eventBus: EventBus;
  readonly filesystem: Filesystem;
  readonly ipc: IpcConnector & IpcListenerFactory;
  readonly npm: NpmCli;
  readonly role: DaemonRole;
  readonly version: string;
  readonly versionCheck: VersionCheck;
}

// why: both roles share these; each adds what it holds leases with.
export function updateOptionsFor(
  parts: UpdateOptionsParts,
): Omit<UpdateCoordinatorOptions, "leasing" | "registry"> {
  const { dataDirectory, ipc, role } = parts;
  return {
    clock: parts.clock,
    dataDirectory,
    eventBus: parts.eventBus,
    filesystem: parts.filesystem,
    latestVersion: () => parts.versionCheck.latest(),
    launcher: new NodeUpdaterLauncher(),
    logPath: join(dataDirectory, "daemon.log"),
    npm: parts.npm,
    otherRoleRunning: () =>
      socketHeld(
        ipc,
        resolveDaemonSocketPath(
          daemonDataDirectory(resolveSimlockHome(), role === "worker" ? "gateway" : "worker"),
        ),
      ),
    packageRoot: fileURLToPath(new URL("../../", import.meta.url)),
    pid: process.pid,
    role,
    simlockHome: resolveSimlockHome(),
    version: parts.version,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** why: a history that refuses to start is one a newer simlock wrote or a migration could not fix; the daemon stops rather than run without the figures it promises. */
export function startHistory(
  history: EventHistoryHandle,
  logger: Logger,
  refused: () => void,
): void {
  void history.start().catch((error: unknown) => {
    logger.error("The event history could not start", { message: errorMessage(error) });
    refused();
  });
}

export function stopForRefusedHistory(daemon: { stop(reason: string): Promise<void> }): () => void {
  return () => {
    process.exitCode = 1;
    void daemon.stop("history-refused").catch(() => undefined);
  };
}

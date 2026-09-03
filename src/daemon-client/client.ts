import { type Clock, type DaemonLauncher, type IpcConnector } from "../ports/index.js";
import {
  IpcDaemonConnector,
  type DaemonClientCapabilities,
  type ResolveCredential,
} from "./connector.js";
import type { DaemonConnection } from "./protocol.js";
import { DaemonStartupCoordinator } from "./startup-coordinator.js";

export type { DaemonClientCapabilities, ResolveCredential } from "./connector.js";

export interface ConnectDaemonOptions {
  readonly capabilities?: DaemonClientCapabilities;
  readonly clock: Clock;
  readonly ipc: IpcConnector;
  readonly launcher: DaemonLauncher;
  /** See `ResolveCredential`: run after the socket connects, so an auto-started daemon has
   * already written `admin.token` by the time it is read. */
  readonly resolveCredential?: ResolveCredential;
  readonly socketPath: string;
}

export async function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonConnection> {
  const connector = new IpcDaemonConnector(
    options.ipc,
    options.socketPath,
    options.capabilities,
    options.resolveCredential,
  );
  return new DaemonStartupCoordinator({
    clock: options.clock,
    connector,
    launcher: options.launcher,
  }).connect();
}

export async function connectExistingDaemon(
  socketPath: string,
  ipc: IpcConnector,
  capabilities?: DaemonClientCapabilities,
  resolveCredential?: ResolveCredential,
): Promise<DaemonConnection> {
  return new IpcDaemonConnector(ipc, socketPath, capabilities, resolveCredential).connect();
}

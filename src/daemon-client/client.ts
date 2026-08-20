import { type Clock, type DaemonLauncher, type IpcConnector } from "../ports/index.js";
import { IpcDaemonConnector, type DaemonClientCapabilities } from "./connector.js";
import type { DaemonConnection } from "./protocol.js";
import { DaemonStartupCoordinator } from "./startup-coordinator.js";

export type { DaemonClientCapabilities } from "./connector.js";

export interface ConnectDaemonOptions {
  readonly capabilities?: DaemonClientCapabilities;
  readonly clock: Clock;
  readonly ipc: IpcConnector;
  readonly launcher: DaemonLauncher;
  readonly socketPath: string;
}

export async function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonConnection> {
  const connector = new IpcDaemonConnector(options.ipc, options.socketPath, options.capabilities);
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
): Promise<DaemonConnection> {
  return new IpcDaemonConnector(ipc, socketPath, capabilities).connect();
}

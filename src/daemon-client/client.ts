import { type Clock, type DaemonLauncher, type IpcConnector } from "../ports/index.js";
import { IpcDaemonConnector } from "./connector.js";
import type { DaemonConnection } from "./protocol.js";
import { DaemonStartupCoordinator } from "./startup-coordinator.js";

export interface ConnectDaemonOptions {
  readonly clock: Clock;
  readonly dataDirectory: string;
  readonly ipc: IpcConnector;
  readonly launcher: DaemonLauncher;
  readonly socketPath: string;
}

export async function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonConnection> {
  const connector = new IpcDaemonConnector(options.ipc, options.socketPath);
  return new DaemonStartupCoordinator({
    clock: options.clock,
    connector,
    launcher: options.launcher,
  }).connect();
}

export async function connectExistingDaemon(
  socketPath: string,
  ipc: IpcConnector,
): Promise<DaemonConnection> {
  return new IpcDaemonConnector(ipc, socketPath).connect();
}

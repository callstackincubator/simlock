import type { Clock, DaemonLauncher } from "../ports/index.js";
import { IpcError } from "../ports/index.js";
import type { DaemonConnector } from "./connector.js";
import type { DaemonConnection } from "./protocol.js";

export interface DaemonStartupCoordinatorOptions {
  readonly clock: Clock;
  readonly connector: DaemonConnector;
  readonly launcher: DaemonLauncher;
  readonly retryIntervalMs?: number;
  readonly startupTimeoutMs?: number;
}

export class DaemonStartupCoordinator {
  constructor(private readonly options: DaemonStartupCoordinatorOptions) {}

  async connect(): Promise<DaemonConnection> {
    let lastError: unknown;
    try {
      return await this.options.connector.connect();
    } catch (error: unknown) {
      if (!isUnavailable(error)) throw error;
      lastError = error;
    }
    await this.options.launcher.launch();
    const deadline = this.options.clock.now() + (this.options.startupTimeoutMs ?? 5_000);
    while (this.options.clock.now() < deadline) {
      try {
        return await this.options.connector.connect();
      } catch (error: unknown) {
        if (!isUnavailable(error)) throw error;
        lastError = error;
        await delay(this.options.clock, this.options.retryIntervalMs ?? 50);
      }
    }
    throw new Error(`Timed out starting pitlane daemon: ${errorMessage(lastError)}`);
  }
}

function delay(clock: Clock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => clock.setTimer(milliseconds, resolve));
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof IpcError &&
    (error.code === "connection-refused" || error.code === "endpoint-not-found")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

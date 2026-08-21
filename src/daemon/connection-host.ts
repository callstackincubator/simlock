import { dirname } from "node:path";

import type {
  Filesystem,
  IpcConnection,
  IpcConnector,
  IpcListenerFactory,
  Logger,
} from "../ports/index.js";
import { IpcError, NoopLogger } from "../ports/index.js";

export interface ConnectionHost {
  readonly endpoint: string;
  start(accept: (connection: IpcConnection) => void): Promise<void>;
  stop(): Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly endpoint: string) {
    super(`Simlock daemon is already running at ${endpoint}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export interface DaemonEndpointHostOptions {
  readonly connector: IpcConnector;
  readonly endpoint: string;
  readonly filesystem: Filesystem;
  readonly listenerFactory: IpcListenerFactory;
  readonly logger?: Logger;
}

/** Owns endpoint claiming, stale-entry recovery, and listener lifecycle. */
export class DaemonEndpointHost implements ConnectionHost {
  readonly endpoint: string;
  readonly #logger: Logger;
  #listener: Awaited<ReturnType<IpcListenerFactory["listen"]>> | undefined;
  #ownsEndpoint = false;
  #stopped = false;

  constructor(private readonly options: DaemonEndpointHostOptions) {
    this.endpoint = options.endpoint;
    this.#logger = options.logger ?? new NoopLogger();
  }

  // fallow-ignore-next-line complexity -- endpoint claim, stale recovery, and bind form one lifecycle transaction.
  async start(accept: (connection: IpcConnection) => void): Promise<void> {
    if (this.#listener !== undefined || this.#stopped)
      throw new Error("Daemon endpoint host has already been started");
    await this.options.filesystem.mkdirp(dirname(this.endpoint));
    if (await this.options.filesystem.exists(this.endpoint)) {
      try {
        const live = await this.options.connector.connect(this.endpoint);
        await live.close();
        throw new DaemonAlreadyRunningError(this.endpoint);
      } catch (error: unknown) {
        if (error instanceof DaemonAlreadyRunningError) throw error;
        if (!(error instanceof IpcError) || !isUnavailable(error)) throw error;
        this.#logger.warn("Recovered stale daemon socket", {
          endpoint: this.endpoint,
          reason: error.code,
        });
        await this.options.filesystem.rm(this.endpoint);
      }
    }
    try {
      this.#listener = await this.options.listenerFactory.listen(this.endpoint, accept);
      this.#ownsEndpoint = true;
      this.#logger.info("Claimed daemon socket", { endpoint: this.endpoint });
    } catch (error: unknown) {
      if (error instanceof IpcError && error.code === "address-in-use") {
        throw new DaemonAlreadyRunningError(this.endpoint);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#listener?.close();
    this.#listener = undefined;
    if (this.#ownsEndpoint) {
      this.#ownsEndpoint = false;
      await this.options.filesystem.rm(this.endpoint);
      this.#logger.info("Released daemon socket", { endpoint: this.endpoint });
    }
  }
}

function isUnavailable(error: IpcError): boolean {
  return error.code === "connection-refused" || error.code === "endpoint-not-found";
}

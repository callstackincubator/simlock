import { dirname } from "node:path";

import type {
  Filesystem,
  IpcConnection,
  IpcConnector,
  IpcListenerFactory,
  Logger,
} from "../ports/index.js";
import { DATA_DIRECTORY_MODE, IpcError, NoopLogger } from "../ports/index.js";

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

/**
 * why: a second daemon must learn a daemon runs before it opens `state.db`, which migrates the
 * live daemon's file. A socket nobody answers is left for `DaemonEndpointHost.start` to recover.
 */
export async function refuseWhenDaemonAnswers(options: {
  readonly connector: IpcConnector;
  readonly endpoint: string;
}): Promise<void> {
  try {
    const live = await options.connector.connect(options.endpoint);
    await live.close();
  } catch (error: unknown) {
    if (error instanceof IpcError && isUnavailable(error)) return;
    throw error;
  }
  throw new DaemonAlreadyRunningError(options.endpoint);
}

/**
 * why: the daemon makes its data directory owner-only before anything writes into it (the log,
 * `state.db`, the socket). One that already exists is never chmod'ed, since the user chose its
 * mode: this only returns the warning the daemon logs when the group or others can reach it.
 */
export async function prepareDataDirectory(
  filesystem: Filesystem,
  path: string,
): Promise<string | undefined> {
  await filesystem.mkdirp(path, { mode: DATA_DIRECTORY_MODE });
  const mode = ((await filesystem.stat(path)).mode ?? DATA_DIRECTORY_MODE) & 0o777;
  if ((mode & 0o077) === 0) return undefined;
  const octal = mode.toString(8).padStart(3, "0");
  return `data directory ${path} is accessible to other users (mode ${octal}); run chmod 700 ${path}`;
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
    await this.options.filesystem.mkdirp(dirname(this.endpoint), { mode: DATA_DIRECTORY_MODE });
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

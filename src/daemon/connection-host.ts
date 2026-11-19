import { dirname } from "node:path";

import type {
  DirectoryAccessReader,
  Filesystem,
  IpcConnection,
  IpcConnector,
  IpcListenerFactory,
  Logger,
} from "../ports/index.js";
import { DATA_DIRECTORY_MODE, IpcError, isPipeEndpoint, NoopLogger } from "../ports/index.js";

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
 * A connect that times out found a server holding the endpoint (a Windows pipe whose every
 * instance is busy), so it refuses too.
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
    if (!(error instanceof IpcError) || error.code !== "connection-timeout") throw error;
  }
  throw new DaemonAlreadyRunningError(options.endpoint);
}

// why: SYSTEM, Administrators and CREATOR OWNER open every folder anyway; the user is the owner.
const TRUSTED_SIDS = new Set(["S-1-5-18", "S-1-5-32-544", "S-1-3-0"]);
// why: list, read, write and append data, delete, and change the ACL or owner, as bits and as the generic rights.
const READ_OR_CHANGE = 0x1 | 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const GENERIC_READ = 0x80000000;

export interface DataDirectoryOptions {
  readonly platform: NodeJS.Platform;
  readonly directoryAccess: DirectoryAccessReader;
}

/**
 * why: the daemon makes its data directory owner-only before anything writes into it (the log,
 * `state.db`, the socket). One that already exists is never chmod'ed, since the user chose its
 * mode: this only returns the warning the daemon logs when others can reach it. On Windows Node
 * makes the mode bits up from the read-only attribute, so the folder's ACL is read instead; an
 * ACL that cannot be read warns nothing.
 */
export async function prepareDataDirectory(
  filesystem: Filesystem,
  path: string,
  options: DataDirectoryOptions,
): Promise<string | undefined> {
  await filesystem.mkdirp(path, { mode: DATA_DIRECTORY_MODE });
  if (options.platform === "win32") return windowsWarning(path, options.directoryAccess);
  const mode = ((await filesystem.stat(path)).mode ?? DATA_DIRECTORY_MODE) & 0o777;
  if ((mode & 0o077) === 0) return undefined;
  const octal = mode.toString(8).padStart(3, "0");
  return `data directory ${path} is accessible to other users (mode ${octal}); run chmod 700 ${path}`;
}

async function windowsWarning(
  path: string,
  reader: DirectoryAccessReader,
): Promise<string | undefined> {
  const access = await reader.read(path).catch(() => undefined);
  if (access === undefined) return undefined;
  const names = new Set<string>();
  for (const entry of access.entries) {
    if (!entry.allow || entry.sid === access.user || TRUSTED_SIDS.has(entry.sid)) continue;
    if ((entry.rights & READ_OR_CHANGE) !== 0 || (entry.rights & GENERIC_READ) !== 0) {
      names.add(entry.name);
    }
  }
  if (names.size === 0) return undefined;
  const grants = [access.user, "S-1-5-18", "S-1-5-32-544"]
    .map((sid) => `"*${sid}:(OI)(CI)F"`)
    .join(" ");
  return `data directory ${path} is accessible to other users (${[...names].join(", ")}); run icacls "${path}" /inheritance:r /grant:r ${grants}`;
}

export interface DaemonEndpointHostOptions {
  readonly connector: IpcConnector;
  readonly endpoint: string;
  readonly filesystem: Filesystem;
  readonly listenerFactory: IpcListenerFactory;
  readonly logger?: Logger;
}

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

  // why: a named pipe is no file, so it has no directory to make and no stale entry to remove: it is gone when its server is, and a live one makes `listen` fail `address-in-use`.
  get #isFile(): boolean {
    return !isPipeEndpoint(this.endpoint);
  }

  async #claimSocketFile(): Promise<void> {
    await this.options.filesystem.mkdirp(dirname(this.endpoint), { mode: DATA_DIRECTORY_MODE });
    if (!(await this.options.filesystem.exists(this.endpoint))) return;
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

  async start(accept: (connection: IpcConnection) => void): Promise<void> {
    if (this.#listener !== undefined || this.#stopped)
      throw new Error("Daemon endpoint host has already been started");
    if (this.#isFile) await this.#claimSocketFile();
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
      if (this.#isFile) await this.options.filesystem.rm(this.endpoint);
      this.#logger.info("Released daemon socket", { endpoint: this.endpoint });
    }
  }
}

function isUnavailable(error: IpcError): boolean {
  return error.code === "connection-refused" || error.code === "endpoint-not-found";
}

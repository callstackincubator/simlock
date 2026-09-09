/**
 * The one thing a gateway persists (ADR 0005, Decision 3: the worker registry is gateway
 * state): which workers an operator has drained.
 *
 * Everything else on a view is rebuilt from the workers themselves on reconnect, which is why
 * this file holds ids and nothing else. Drain cannot be rebuilt that way -- it is an operator's
 * decision about a machine, not a fact the machine reports -- and losing it is the one failure
 * mode that matters: a gateway restart, or a worker reconnecting after a reboot, would silently
 * put a machine that was taken out of service back into rotation.
 */
import { dirname } from "node:path";

import type { Filesystem, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";

/** Owner-only, like every other file the daemon keeps under `SIMLOCK_HOME` (`tokens.json`,
 * `admin.token`, `state.json`): the trust boundary is the OS user. */
const WORKERS_FILE_MODE = 0o600;

export interface DrainStore {
  load(): Promise<readonly string[]>;
  save(drainedWorkerIds: readonly string[]): Promise<void>;
}

export interface FileDrainStoreOptions {
  readonly filesystem: Filesystem;
  /** `workers.json` under the gateway's data directory. */
  readonly path: string;
  readonly logger?: Logger;
}

/**
 * A tiny JSON file: `{"drained": ["wrk_a", "wrk_b"]}`.
 *
 * Read errors never stop a gateway starting. A corrupt or unreadable file means the gateway
 * forgets which workers were drained -- bad, and logged loudly -- but refusing to start would
 * take a whole fleet's *routing* offline to protect a flag on some of it, which is the worse
 * trade. Write errors are logged and swallowed for the same reason: the drain is already in
 * effect in memory, and failing the operator's `worker.drain` call after it took effect would
 * be a lie in the other direction.
 */
export class FileDrainStore implements DrainStore {
  readonly #logger: Logger;

  constructor(private readonly options: FileDrainStoreOptions) {
    this.#logger = options.logger ?? new NoopLogger();
  }

  async load(): Promise<readonly string[]> {
    if (!(await this.options.filesystem.exists(this.options.path))) return [];
    try {
      const parsed: unknown = JSON.parse(await this.options.filesystem.readFile(this.options.path));
      const drained = (parsed as { readonly drained?: unknown } | null)?.drained;
      if (!Array.isArray(drained)) throw new Error("`drained` is not an array");
      return drained.filter((id): id is string => typeof id === "string");
    } catch (error: unknown) {
      this.#logger.error("Could not read the gateway's worker registry; drains are forgotten", {
        path: this.options.path,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async save(drainedWorkerIds: readonly string[]): Promise<void> {
    try {
      await this.options.filesystem.mkdirp(dirname(this.options.path));
      await this.options.filesystem.writeFileAtomic(
        this.options.path,
        `${JSON.stringify({ drained: [...drainedWorkerIds] }, null, 2)}\n`,
        { mode: WORKERS_FILE_MODE },
      );
    } catch (error: unknown) {
      this.#logger.error("Could not persist the gateway's worker registry", {
        path: this.options.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** For tests and for a gateway with nowhere to write: remembers nothing across a restart. */
export class MemoryDrainStore implements DrainStore {
  #drained: readonly string[] = [];

  async load(): Promise<readonly string[]> {
    return this.#drained;
  }

  async save(drainedWorkerIds: readonly string[]): Promise<void> {
    this.#drained = [...drainedWorkerIds];
  }
}

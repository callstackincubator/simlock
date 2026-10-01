import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import {
  exitCodeOf,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessStreamOptions,
  type StreamingProcessHandle,
} from "./process-runner.js";

export interface LoggingProcessRunnerOptions {
  readonly clock: Clock;
  readonly inner: ProcessRunner;
  readonly logger: Logger;
}

/**
 * Writes one `debug` line per device command when it settles: the command, its arguments, its
 * exit code (or the error it threw) and how long it took. Never its environment, its input, or
 * anything it printed -- an environment can hold credentials, and a `device.exec` command's
 * output belongs to the caller who ran it, not to the daemon log.
 *
 * Errors pass through unchanged; this wrapper only watches.
 */
export class LoggingProcessRunner implements ProcessRunner {
  readonly #clock: Clock;
  readonly #inner: ProcessRunner;
  readonly #logger: Logger;

  constructor(options: LoggingProcessRunnerOptions) {
    this.#clock = options.clock;
    this.#inner = options.inner;
    this.#logger = options.logger;
  }

  async run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    const startedAt = this.#clock.now();
    try {
      const result = await this.#inner.run(command, args, options);
      this.#exited(command, args, startedAt, result.code);
      return result;
    } catch (error) {
      this.#failed(command, args, startedAt, error);
      throw error;
    }
  }

  spawn(command: string, args: readonly string[], options?: ProcessRunOptions): ProcessHandle {
    const startedAt = this.#clock.now();
    const handle = this.#watchStart(command, args, startedAt, () =>
      this.#inner.spawn(command, args, options),
    );
    handle.wait().then(
      (result) => this.#exited(command, args, startedAt, result.code),
      (error: unknown) => this.#failed(command, args, startedAt, error),
    );
    return handle;
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    const startedAt = this.#clock.now();
    const handle = this.#watchStart(command, args, startedAt, () =>
      this.#inner.spawnStreaming(command, args, options),
    );
    handle.wait().then(
      (result) => this.#exited(command, args, startedAt, exitCodeOf(result)),
      (error: unknown) => this.#failed(command, args, startedAt, error),
    );
    return handle;
  }

  /** A child that could not be started at all throws here, synchronously: log it, rethrow. */
  #watchStart<Handle>(
    command: string,
    args: readonly string[],
    startedAt: number,
    start: () => Handle,
  ): Handle {
    try {
      return start();
    } catch (error) {
      this.#failed(command, args, startedAt, error);
      throw error;
    }
  }

  #exited(command: string, args: readonly string[], startedAt: number, code: number | null): void {
    this.#logger.debug("process", {
      command,
      args: [...args],
      code,
      durationMs: this.#clock.now() - startedAt,
    });
  }

  #failed(command: string, args: readonly string[], startedAt: number, error: unknown): void {
    this.#logger.debug("process", {
      command,
      args: [...args],
      error: error instanceof Error ? error.message : String(error),
      durationMs: this.#clock.now() - startedAt,
    });
  }
}

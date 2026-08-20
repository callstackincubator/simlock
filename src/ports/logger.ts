import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { Clock } from "./clock.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogRecord {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly module: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

/** Operational (not business-event) logging port. Never `console` directly — see architecture rule 9. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Returns a logger scoped to `module`, dot-joined with any existing scope. */
  child(module: string): Logger;
}

/** Receives one already-formatted line per record. Owns whatever storage/rotation backs it. */
export interface LogSink {
  write(line: string): void;
}

export interface JsonLinesLoggerOptions {
  readonly clock: Clock;
  readonly level?: LogLevel;
  readonly module?: string;
  readonly sink: LogSink;
}

/** Formats one JSON object per line and hands it to an injected {@link LogSink}. */
export class JsonLinesLogger implements Logger {
  readonly #clock: Clock;
  readonly #level: LogLevel;
  readonly #module: string;
  readonly #sink: LogSink;

  constructor(options: JsonLinesLoggerOptions) {
    this.#clock = options.clock;
    this.#level = options.level ?? "info";
    this.#module = options.module ?? "daemon";
    this.#sink = options.sink;
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.#log("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.#log("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.#log("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.#log("error", message, fields);
  }

  child(module: string): Logger {
    return new JsonLinesLogger({
      clock: this.#clock,
      level: this.#level,
      module: `${this.#module}.${module}`,
      sink: this.#sink,
    });
  }

  #log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) {
      return;
    }
    const record: LogRecord = {
      timestamp: this.#clock.now(),
      level,
      module: this.#module,
      message,
      ...(fields === undefined ? {} : { fields }),
    };
    this.#sink.write(JSON.stringify(record));
  }
}

/** Discards every record. Used as the default when no logger is injected. */
export class NoopLogger implements Logger {
  debug(_message: string, _fields?: Record<string, unknown>): void {}
  info(_message: string, _fields?: Record<string, unknown>): void {}
  warn(_message: string, _fields?: Record<string, unknown>): void {}
  error(_message: string, _fields?: Record<string, unknown>): void {}

  child(_module?: string): Logger {
    return this;
  }
}

/** In-memory sink for tests: exposes each record already parsed, never raw string fragments. */
export class MemoryLogSink implements LogSink {
  readonly #lines: string[] = [];

  write(line: string): void {
    this.#lines.push(line);
  }

  get records(): readonly LogRecord[] {
    return this.#lines.map((line) => JSON.parse(line) as LogRecord);
  }
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface NodeFileLogSinkOptions {
  readonly maxBytes?: number;
  readonly path: string;
}

/**
 * Appends to `path` via a held file descriptor, tracking bytes written. Once a write
 * would push the file past `maxBytes`, the current file is renamed to `<path>.1`
 * (replacing any existing generation) and a fresh file is opened. Exactly one rotated
 * generation is kept.
 *
 * Writes are synchronous (`writeSync`), deliberately, not by oversight: this keeps
 * records strictly ordered without a write queue, guarantees a line is never split
 * across an interleaved write to the same fd (`NodeDaemonLauncher` hands the child an
 * inherited append fd on this same path for uncaught fatal output -- see below), and is
 * the only kind of write that reliably lands from a handler where the process is about
 * to exit. This is sound only because volume is low by design: operational lifecycle
 * lines (startup, connection churn, shutdown), not per-request logging.
 *
 * `#bytesWritten` only counts what this sink itself writes. The daemon launcher's
 * inherited fd can append a fatal crash dump to the same file without going through
 * this class, so the cap is a soft bound -- "one crash dump" -- not a hard guarantee
 * that the file never exceeds `maxBytes`.
 */
export class NodeFileLogSink implements LogSink {
  readonly #path: string;
  readonly #maxBytes: number;
  #fd: number;
  #bytesWritten: number;

  constructor(options: NodeFileLogSinkOptions) {
    this.#path = options.path;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    mkdirSync(dirname(this.#path), { recursive: true });
    this.#fd = openSync(this.#path, "a");
    this.#bytesWritten = fstatSync(this.#fd).size;
  }

  write(line: string): void {
    const chunk = `${line}\n`;
    const size = Buffer.byteLength(chunk);
    if (this.#bytesWritten > 0 && this.#bytesWritten + size > this.#maxBytes) {
      this.#rotate();
    }
    writeSync(this.#fd, chunk);
    this.#bytesWritten += size;
  }

  /**
   * Not called anywhere in production: `startDaemon` builds this sink once at startup
   * and never tears it down, relying on the fd closing at process exit. Deliberate --
   * threading a close-on-shutdown path through `main.ts` would couple the daemon's
   * shutdown sequence to this specific adapter for no real benefit. Kept as a public
   * method purely so tests can close and reopen deterministically.
   */
  close(): void {
    closeSync(this.#fd);
  }

  #rotate(): void {
    closeSync(this.#fd);
    renameSync(this.#path, `${this.#path}.1`);
    this.#fd = openSync(this.#path, "a");
    this.#bytesWritten = 0;
  }
}

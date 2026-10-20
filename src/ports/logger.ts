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
// why: Owner-only, like the other files that hold secrets or state (`config.json`,
// `state.db`, `admin.token`): the trust boundary is the OS user, and a shared
// runner's other users have no business reading a daemon's log. Set at each
// `open`, never a later `chmod`, so no generation is ever born world-readable.
const FILE_MODE = 0o600;

export interface NodeFileLogSinkOptions {
  readonly maxBytes?: number;
  readonly path: string;
}

// why: writes are synchronous so records stay strictly ordered, a line is never split across a write to the
// same fd (the daemon launcher hands the child an inherited append fd on this path), and a write lands from a
// handler where the process is about to exit; the cap is soft because that inherited fd bypasses `#bytesWritten`.
export class NodeFileLogSink implements LogSink {
  readonly #path: string;
  readonly #maxBytes: number;
  #fd: number;
  #bytesWritten: number;

  constructor(options: NodeFileLogSinkOptions) {
    this.#path = options.path;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    mkdirSync(dirname(this.#path), { recursive: true });
    this.#fd = openSync(this.#path, "a", FILE_MODE);
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

  close(): void {
    closeSync(this.#fd);
  }

  #rotate(): void {
    closeSync(this.#fd);
    renameSync(this.#path, `${this.#path}.1`);
    this.#fd = openSync(this.#path, "a", FILE_MODE);
    this.#bytesWritten = 0;
  }
}

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { type Clock, SystemClock } from "./clock.js";

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
/** Enough to hold the last line of any record this tool writes; a generation is never read whole. */
const TAIL_BYTES = 64 * 1024;

function readTail(file: string): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface NodeFileLogSinkOptions {
  /** One generation: the size at which the current file rotates. */
  readonly maxBytes?: number;
  readonly path: string;
  /**
   * With `retentionMs` or `totalMaxBytes`, rotation keeps numbered generations (`<path>.1`
   * newest, upward) and sweeps them; without both, exactly one generation is kept.
   */
  readonly retentionMs?: number;
  readonly totalMaxBytes?: number;
  /** Judges a generation's age; the system clock when absent. */
  readonly clock?: Clock;
}

/**
 * Appends to `path` via a held file descriptor, tracking bytes written. Once a write
 * would push the file past `maxBytes`, the current file is renamed to `<path>.1`
 * (replacing any existing generation) and a fresh file is opened. Exactly one rotated
 * generation is kept -- unless `retentionMs` or `totalMaxBytes` is given: then existing
 * generations shift up one number, and the sweep deletes (only ever `<path>.N` beside this
 * sink's own path) every generation whose newest line is older than `retentionMs`, then the
 * oldest until the generations plus the current file fit `totalMaxBytes`. The current file is
 * never deleted. The same sweep runs once when the sink opens. A generation's age is the
 * `timestamp` of its last line when that line is JSON carrying one, else the file's mtime.
 *
 * Writes are synchronous (`writeSync`), deliberately, not by oversight: this keeps
 * records strictly ordered without a write queue, guarantees a line is never split
 * across an interleaved write to the same fd (`NodeDaemonLauncher` hands the child an
 * inherited append fd on this same path for uncaught fatal output -- see below), and is
 * the only kind of write that reliably lands from a handler where the process is about
 * to exit. The cost is that every line blocks its caller on a disk write, and volume is
 * no longer low: `daemon.log` gets a line per operation, and at `debug` a line per device
 * command; `events.jsonl` a line per business event. Accepted as long as a line stays one
 * small `writeSync`.
 *
 * `#bytesWritten` only counts what this sink itself writes. The daemon launcher's
 * inherited fd can append a fatal crash dump to the same file without going through
 * this class, so the cap is a soft bound -- "one crash dump" -- not a hard guarantee
 * that the file never exceeds `maxBytes`.
 */
export class NodeFileLogSink implements LogSink {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #retentionMs: number | undefined;
  readonly #totalMaxBytes: number | undefined;
  readonly #clock: Clock;
  #fd: number;
  #bytesWritten: number;

  constructor(options: NodeFileLogSinkOptions) {
    this.#path = options.path;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#retentionMs = options.retentionMs;
    this.#totalMaxBytes = options.totalMaxBytes;
    this.#clock = options.clock ?? new SystemClock();
    mkdirSync(dirname(this.#path), { recursive: true });
    this.#fd = openSync(this.#path, "a");
    this.#bytesWritten = fstatSync(this.#fd).size;
    this.#sweep();
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
   * Not called anywhere in production: `startDaemon` builds its sinks (`daemon.log`,
   * `events.jsonl`) once at startup and never tears them down, relying on the fd closing at process exit. Deliberate --
   * threading a close-on-shutdown path through `main.ts` would couple the daemon's
   * shutdown sequence to this specific adapter for no real benefit. Kept as a public
   * method purely so tests can close and reopen deterministically.
   */
  close(): void {
    closeSync(this.#fd);
  }

  #rotate(): void {
    closeSync(this.#fd);
    if (this.#retentionMs !== undefined || this.#totalMaxBytes !== undefined) {
      this.#shiftGenerations();
    }
    renameSync(this.#path, `${this.#path}.1`);
    this.#fd = openSync(this.#path, "a");
    this.#bytesWritten = 0;
    this.#sweep();
  }

  /** `<path>.N` -> `<path>.N+1`, highest first, so no generation overwrites another. */
  #shiftGenerations(): void {
    let highest = 0;
    while (existsSync(`${this.#path}.${highest + 1}`)) highest += 1;
    for (let generation = highest; generation >= 1; generation -= 1) {
      renameSync(`${this.#path}.${generation}`, `${this.#path}.${generation + 1}`);
    }
  }

  #sweep(): void {
    if (this.#retentionMs === undefined && this.#totalMaxBytes === undefined) return;
    const sizes: number[] = [];
    while (existsSync(`${this.#path}.${sizes.length + 1}`)) {
      sizes.push(statSync(`${this.#path}.${sizes.length + 1}`).size);
    }
    // Generations get older with their number, so what is past retention, or over the cap, is
    // a suffix; keeping the survivors contiguous is what lets a reader stop at the first
    // missing one.
    const keep = this.#fitSize(sizes, this.#withinRetention(sizes.length));
    for (let generation = sizes.length; generation > keep; generation -= 1) {
      unlinkSync(`${this.#path}.${generation}`);
    }
  }

  /** How many of the `count` generations are not past `retentionMs`. */
  #withinRetention(count: number): number {
    if (this.#retentionMs === undefined) return count;
    const cutoff = this.#clock.now() - this.#retentionMs;
    let keep = count;
    while (keep > 0 && this.#newestLine(`${this.#path}.${keep}`) < cutoff) keep -= 1;
    return keep;
  }

  /** How many of the first `keep` generations fit `totalMaxBytes` beside the current file. */
  #fitSize(sizes: readonly number[], keep: number): number {
    if (this.#totalMaxBytes === undefined) return keep;
    // The current file is counted at its full size, not what it holds now: it is about to
    // fill, and the cap is a promise about the total once it has.
    let total = Math.max(this.#bytesWritten, this.#maxBytes);
    for (let index = 0; index < keep; index += 1) total += sizes[index] ?? 0;
    let kept = keep;
    while (kept > 0 && total > this.#totalMaxBytes) {
      kept -= 1;
      total -= sizes[kept] ?? 0;
    }
    return kept;
  }

  /** The time of a generation's newest line: its `timestamp` field, else the file's mtime. */
  #newestLine(file: string): number {
    const lines = readTail(file).trimEnd().split("\n");
    try {
      const parsed: unknown = JSON.parse(lines[lines.length - 1] ?? "");
      const timestamp = (parsed as { timestamp?: unknown } | null)?.timestamp;
      if (typeof timestamp === "number") return timestamp;
    } catch {
      // Not JSON: fall through to the file's own time.
    }
    return statSync(file).mtimeMs;
  }
}

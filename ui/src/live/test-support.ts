/**
 * A scripted daemon for the live layer's tests: the three API calls the layer makes, each
 * recorded with the fake clock's time, and a visibility the test flips. Every timer the layer
 * sets runs on vitest's fake timers, so a test moves time with `vi.advanceTimersByTimeAsync`.
 */
import { vi } from "vitest";

import { type ApiPath, type ApiResponse } from "../api";
import { type Clock, LiveConnection, type LiveApi, type Visibility } from "./connection";

const fakeClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One stream the layer opened: what the test sends down it, and whether the layer closed it. */
interface FakeStream {
  send(text: string): void;
  /** The daemon ends the stream. */
  end(): void;
  readonly closedByConsole: () => boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

class FakeDaemon implements LiveApi {
  /** Every read, by path and the time it was sent. */
  readonly gets: { readonly path: ApiPath; readonly at: number }[] = [];
  readonly healthChecks: number[] = [];
  readonly streams: FakeStream[] = [];
  /**
   * How the next reads answer. `"answer"` (the default) answers at once; `"hold"` keeps each
   * read pending until `release()`; a function decides per read.
   */
  reads: "answer" | "hold" | ((path: ApiPath) => Promise<ApiResponse<unknown>>) = "answer";
  /** Whether a new stream's headers wait for `release()`, as a starting daemon's do. */
  holdStreams = false;
  /** What `/v1/healthz` does: answer up, answer down, or fail at the network level. */
  health: "up" | "down" | "unreachable" = "up";
  /** The `Date` header every answer carries. */
  date: string | null = null;
  readonly #held: Deferred<ApiResponse<unknown>>[] = [];
  readonly #heldStreams: (() => void)[] = [];
  readonly #encoder = new TextEncoder();

  get(path: ApiPath): Promise<ApiResponse<never>> {
    this.gets.push({ at: Date.now(), path });
    const reads = this.reads;
    if (typeof reads === "function") return reads(path) as Promise<ApiResponse<never>>;
    if (reads === "hold") {
      const held = deferred<ApiResponse<unknown>>();
      this.#held.push(held);
      return held.promise as Promise<ApiResponse<never>>;
    }
    return Promise.resolve({ body: { read: this.gets.length }, date: this.date } as never);
  }

  /** Answers every held read, and sends the headers of every held stream. */
  release(): void {
    for (const held of this.#held.splice(0))
      held.resolve({ body: { held: true }, date: this.date });
    for (const open of this.#heldStreams.splice(0)) open();
  }

  healthz(): Promise<ApiResponse<boolean>> {
    this.healthChecks.push(Date.now());
    if (this.health === "unreachable") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ body: this.health === "up", date: this.date });
  }

  stream(_path: ApiPath, signal: AbortSignal): Promise<ApiResponse<ReadableStream<Uint8Array>>> {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    signal.addEventListener("abort", () => {
      closed = true;
      try {
        controller.error(new DOMException("The stream was aborted", "AbortError"));
      } catch {
        // Already closed by the daemon's side.
      }
    });
    this.streams.push({
      closedByConsole: () => closed,
      end: () => controller.close(),
      send: (text) => controller.enqueue(this.#encoder.encode(text)),
    });
    const response = { body, date: this.date };
    if (!this.holdStreams) return Promise.resolve(response);
    return new Promise((resolve) => this.#heldStreams.push(() => resolve(response)));
  }

  /** The stream the layer has open now, if any. */
  openStream(): FakeStream | undefined {
    const last = this.streams.at(-1);
    return last === undefined || last.closedByConsole() ? undefined : last;
  }
}

class FakeVisibility implements Visibility {
  #hidden = false;
  readonly #listeners = new Set<() => void>();

  hidden(): boolean {
    return this.#hidden;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  set(hidden: boolean): void {
    this.#hidden = hidden;
    for (const listener of this.#listeners) listener();
  }
}

/** A connection on a fake daemon, with fake timers already on. */
export function connect(): {
  readonly connection: LiveConnection;
  readonly daemon: FakeDaemon;
  readonly visibility: FakeVisibility;
} {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  const daemon = new FakeDaemon();
  const visibility = new FakeVisibility();
  const connection = new LiveConnection({ api: daemon, clock: fakeClock, visibility });
  return { connection, daemon, visibility };
}

/** Lets every promise the layer is waiting on settle, without moving the clock. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

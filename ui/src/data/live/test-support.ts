import { vi } from "vitest";

import { type ApiPath, type ApiResponse, type ConditionalResponse, type ReadOptions } from "../api";
import {
  type Clock,
  LiveConnection,
  type LiveApi,
  type LiveConnectionOptions,
  type Visibility,
} from "./connection";

export const fakeClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface FakeStream {
  send(text: string): void;
  end(): void;
  break(): void;
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
  readonly gets: { readonly path: ApiPath; readonly at: number; readonly tag?: string }[] = [];
  readonly healthChecks: number[] = [];
  readonly streams: FakeStream[] = [];
  reads:
    | "answer"
    | "hold"
    | ((path: ApiPath) => Promise<ApiResponse<unknown> | ConditionalResponse<unknown>>) = "answer";
  holdStreams = false;
  refuseStreams: (() => Promise<never>) | undefined;
  health: "up" | "down" | "unreachable" = "up";
  date: string | null = null;
  // why: the tag every route answers with; a read that sends it back gets a 304.
  etag: string | undefined;
  readonly #held: Deferred<ApiResponse<unknown>>[] = [];
  readonly #heldStreams: (() => void)[] = [];
  readonly #encoder = new TextEncoder();

  get<T>(path: ApiPath): Promise<ApiResponse<T>>;
  get<T>(path: ApiPath, options: ReadOptions): Promise<ConditionalResponse<T>>;
  get(
    path: ApiPath,
    options?: ReadOptions,
  ): Promise<ApiResponse<unknown> | ConditionalResponse<unknown>> {
    const tag = options?.tag;
    this.gets.push({ at: Date.now(), path, ...(tag === undefined ? {} : { tag }) });
    const reads = this.reads;
    if (reads === "answer" && tag !== undefined && tag === this.etag) {
      return Promise.resolve({ date: this.date, notModified: true });
    }
    if (typeof reads === "function") return reads(path);
    if (reads === "hold") return this.#hold() as Promise<ApiResponse<unknown>>;
    return Promise.resolve({
      body: { read: this.gets.length },
      date: this.date,
      tag: this.etag ?? null,
    } as never);
  }

  #hold(): Promise<ApiResponse<unknown>> {
    const held = deferred<ApiResponse<unknown>>();
    this.#held.push(held);
    return held.promise;
  }

  openHeldStreams(): void {
    for (const open of this.#heldStreams.splice(0)) open();
  }

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
        // why: already closed by the daemon's side.
      }
    });
    this.streams.push({
      break: () => controller.error(new TypeError("network error")),
      closedByConsole: () => closed,
      end: () => controller.close(),
      send: (text) => controller.enqueue(this.#encoder.encode(text)),
    });
    if (this.refuseStreams !== undefined) return this.refuseStreams();
    const response = { body, date: this.date };
    if (!this.holdStreams) return Promise.resolve(response);
    // why: as `fetch` does, a request aborted before its headers arrive rejects with an AbortError.
    return new Promise((resolve, reject) => {
      this.#heldStreams.push(() => resolve(response));
      signal.addEventListener("abort", () =>
        reject(new DOMException("The request was aborted", "AbortError")),
      );
    });
  }

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

export function connect(whenLost?: LiveConnectionOptions["whenLost"]): {
  readonly connection: LiveConnection;
  readonly daemon: FakeDaemon;
  readonly visibility: FakeVisibility;
} {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  const daemon = new FakeDaemon();
  const visibility = new FakeVisibility();
  const connection = new LiveConnection({
    api: daemon,
    clock: fakeClock,
    visibility,
    ...(whenLost === undefined ? {} : { whenLost }),
  });
  return { connection, daemon, visibility };
}

export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

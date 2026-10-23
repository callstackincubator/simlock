import {
  ApiError,
  type ApiClient,
  type ApiPath,
  type ConditionalResponse,
  type ReadOptions,
  RequestTimeoutError,
} from "../api";
import { createSseParser, type SseMessage } from "./sse";
import { clockOffset } from "./clock";

const STREAM_RETRY_MS = 1_000;
// why: more than two of the daemon's 15-second keepalives, so one lost keepalive never marks a live
// stream dead.
const STREAM_SILENCE_MS = 40_000;
const HEALTHZ_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;
const HEALTHZ_INTERVAL_MS = 10_000;
const STREAM_PATH = "/v1/events/stream";

export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Visibility {
  hidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export type LiveApi = Pick<ApiClient, "get" | "healthz" | "stream">;

export interface ResourceState<T> {
  // why: kept while a later request fails, so the screen keeps its data.
  readonly data?: T;
  readonly error?: unknown;
}

export type ConnectionPhase = "connected" | "disconnected" | "starting";

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  readonly answeredAt?: number;
}

export interface StreamEvent {
  readonly event: string;
  readonly data: unknown;
}

export interface StreamOpened {
  // why: a stream that died without closing counts from its last sign of life, not from when the
  // console noticed.
  readonly closedForMs?: number;
}

// why: a read lost to the network is not a fact about its route; the connection takes it as its
// own loss, and a page never shows it as an error.
export class ConnectionLost extends Error {
  constructor() {
    super("The connection to the daemon was lost");
    this.name = "ConnectionLost";
  }
}

// why: in a proxy session a loss may be the proxy's own session ending, which only the session can
// tell: `reconnect` (still the proxy's person), `backoff` (Simlock is unreachable) or `stop` (the
// session ended and the session handles it).
export type LostAnswer = "reconnect" | "backoff" | "stop";

export interface LiveConnectionOptions {
  readonly whenLost?: () => Promise<LostAnswer>;
  readonly api: LiveApi;
  readonly clock: Clock;
  readonly visibility: Visibility;
}

export function isRefusal(error: unknown): boolean {
  return error instanceof ApiError || error instanceof SyntaxError;
}

export type ConditionalRead<T> =
  | { readonly notModified: true }
  | { readonly notModified?: false; readonly body: T; readonly tag: string | null };

function conditional<T>(response: ConditionalResponse<T>): ConditionalRead<T> {
  return response.notModified === true
    ? { notModified: true }
    : { body: response.body, tag: response.tag };
}

export class LiveConnection {
  readonly #api: LiveApi;
  readonly #clock: Clock;
  readonly #visibility: Visibility;
  readonly #whenLost: (() => Promise<LostAnswer>) | undefined;
  readonly #stateListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: StreamEvent) => void>();
  readonly #openListeners = new Set<(opened: StreamOpened) => void>();
  readonly #stopWatchingVisibility: () => void;
  #state: ConnectionState = { phase: "connected" };
  #answeredAt: number | undefined;
  #offset = 0;
  #disposed = false;
  #streamRetryTimer: unknown;
  #healthTimer: unknown;
  #healthAttempt = 0;
  #silenceTimer: unknown;
  #stream: AbortController | undefined;
  #streamIsOpen = false;
  #streamHeardAt: number | undefined;
  #streamClosedAt: number | undefined;

  constructor(options: LiveConnectionOptions) {
    this.#api = options.api;
    this.#clock = options.clock;
    this.#visibility = options.visibility;
    this.#whenLost = options.whenLost;
    this.#stopWatchingVisibility = this.#visibility.subscribe(() => this.#visibilityChanged());
    if (!this.#visibility.hidden()) {
      this.#openStream();
    }
  }

  // why: one GET with the classification every read gets: a refusal is the route's own answer and
  // the daemon is there; a timeout while the daemon starts is asked again; anything else is the
  // connection lost.
  async read<T>(path: ApiPath, options: ReadOptions): Promise<ConditionalRead<T>> {
    for (;;) {
      let response;
      try {
        response = await this.#api.get<T>(path, options);
      } catch (error: unknown) {
        if (this.#disposed) throw error;
        switch (this.#classify(error)) {
          case "refused":
            this.#daemonAnswered();
            throw error;
          case "retry":
            if (this.#reading()) continue;
            // why: a read that gave up while the tab is hidden is a read lost, not the route's answer.
            throw new ConnectionLost();
          case "lost":
            this.#lose();
            throw new ConnectionLost();
        }
      }
      if (!this.#disposed) {
        this.#observe(response.date);
        this.#answeredAt = this.#clock.now();
        this.#daemonAnswered();
      }
      return conditional(response);
    }
  }

  state(): ConnectionState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  serverNow(): number {
    return this.#clock.now() + this.#offset;
  }

  onEvent(listener: (event: StreamEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  onStreamOpened(listener: (opened: StreamOpened) => void): () => void {
    this.#openListeners.add(listener);
    return () => {
      this.#openListeners.delete(listener);
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopWatchingVisibility();
    this.#stopStreamRetry();
    this.#closeStream();
    this.#clock.clearTimeout(this.#healthTimer);
    this.#stateListeners.clear();
    this.#eventListeners.clear();
    this.#openListeners.clear();
  }

  #reading(): boolean {
    return !this.#disposed && !this.#visibility.hidden() && this.#state.phase !== "disconnected";
  }

  // why: a starting daemon holds every request until it is ready, so a request that gave up waiting
  // (`retry`) is sent again instead of counted as a loss.
  #classify(error: unknown): "refused" | "retry" | "lost" {
    if (isRefusal(error)) return "refused";
    if (error instanceof RequestTimeoutError && this.#state.phase === "starting") return "retry";
    return "lost";
  }

  #observe(date: string | null): void {
    const offset = clockOffset(date, this.#clock.now());
    if (offset !== undefined) this.#offset = offset;
  }

  #daemonAnswered(): void {
    if (this.#state.phase !== "starting") return;
    this.#setState("connected");
  }

  #setState(phase: ConnectionPhase): void {
    const answeredAt = this.#answeredAt;
    this.#state =
      phase === "connected" || answeredAt === undefined ? { phase } : { answeredAt, phase };
    for (const listener of this.#stateListeners) listener();
  }

  #stopStreamRetry(): void {
    this.#clock.clearTimeout(this.#streamRetryTimer);
    this.#streamRetryTimer = undefined;
  }

  #openStream(): void {
    this.#closeStream();
    const controller = new AbortController();
    this.#stream = controller;
    void this.#readStream(controller);
  }

  #closeStream(): void {
    this.#clock.clearTimeout(this.#silenceTimer);
    const stream = this.#stream;
    if (stream === undefined) return;
    this.#stream = undefined;
    stream.abort();
    if (this.#streamIsOpen) this.#streamClosedAt = this.#streamHeardAt;
    this.#streamIsOpen = false;
  }

  async #readStream(controller: AbortController): Promise<void> {
    const body = await this.#connectStream(controller);
    if (body === undefined) return;
    if (this.#stream !== controller) {
      // why: closed while its headers were being handed over, by a loss or a hidden tab.
      void body.cancel().catch(() => undefined);
      return;
    }
    this.#streamOpened();
    const ended = await this.#follow(controller, body);
    if (ended) this.#lose();
  }

  async #connectStream(
    controller: AbortController,
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    try {
      const response = await this.#api.stream(STREAM_PATH, controller.signal);
      if (this.#stream !== controller) {
        void response.body.cancel().catch(() => undefined);
        return undefined;
      }
      this.#observe(response.date);
      this.#daemonAnswered();
      return response.body;
    } catch (error: unknown) {
      if (this.#stream !== controller) return undefined;
      const outcome = this.#classify(error);
      if (outcome === "retry") this.#openStream();
      else if (outcome === "lost") this.#lose();
      else {
        // why: refused means the daemon is there: no stream for now, and one is asked for again a
        // second later.
        this.#stream = undefined;
        this.#daemonAnswered();
        this.#retryStreamLater();
      }
      return undefined;
    }
  }

  #retryStreamLater(): void {
    this.#stopStreamRetry();
    this.#streamRetryTimer = this.#clock.setTimeout(() => {
      this.#streamRetryTimer = undefined;
      if (this.#reading() && this.#stream === undefined) this.#openStream();
    }, STREAM_RETRY_MS);
  }

  async #follow(controller: AbortController, body: ReadableStream<Uint8Array>): Promise<boolean> {
    const reader = body.getReader();
    const parser = createSseParser();
    this.#watchSilence(controller);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.#stream !== controller) return false;
        if (done) return true;
        this.#streamHeardAt = this.#clock.now();
        this.#watchSilence(controller);
        for (const message of parser.push(value)) this.#deliver(message);
      }
    } catch {
      return this.#stream === controller;
    }
  }

  #streamOpened(): void {
    this.#streamIsOpen = true;
    this.#streamHeardAt = this.#clock.now();
    const closedAt = this.#streamClosedAt;
    this.#streamClosedAt = undefined;
    const opened: StreamOpened =
      closedAt === undefined ? {} : { closedForMs: this.#clock.now() - closedAt };
    for (const listener of this.#openListeners) listener(opened);
  }

  #watchSilence(controller: AbortController): void {
    this.#clock.clearTimeout(this.#silenceTimer);
    this.#silenceTimer = this.#clock.setTimeout(() => {
      if (this.#stream === controller) this.#lose();
    }, STREAM_SILENCE_MS);
  }

  #deliver(message: SseMessage): void {
    let data: unknown;
    try {
      data = JSON.parse(message.data) as unknown;
    } catch {
      data = undefined;
    }
    for (const listener of this.#eventListeners) listener({ data, event: message.event });
  }

  #lose(): void {
    if (this.#disposed || this.#state.phase === "disconnected") return;
    this.#stopStreamRetry();
    this.#closeStream();
    this.#setState("disconnected");
    this.#healthAttempt = 0;
    if (this.#visibility.hidden()) return;
    if (this.#whenLost === undefined) this.#scheduleHealthCheck();
    else void this.#askWhenLost(this.#whenLost);
  }

  async #askWhenLost(whenLost: () => Promise<LostAnswer>): Promise<void> {
    let answer: LostAnswer;
    try {
      answer = await whenLost();
    } catch {
      answer = "backoff";
    }
    // why: a tab shown meanwhile asks `/v1/healthz` itself.
    if (this.#disposed || this.#visibility.hidden() || this.#state.phase !== "disconnected") return;
    if (answer === "reconnect") this.#reconnect();
    else if (answer === "backoff") this.#scheduleHealthCheck();
  }

  #reconnect(): void {
    this.#setState("starting");
    this.#openStream();
  }

  #scheduleHealthCheck(): void {
    const delay = HEALTHZ_BACKOFF_MS[this.#healthAttempt] ?? HEALTHZ_INTERVAL_MS;
    this.#healthAttempt += 1;
    this.#clock.clearTimeout(this.#healthTimer);
    this.#healthTimer = this.#clock.setTimeout(() => {
      this.#healthTimer = undefined;
      void this.#checkHealth();
    }, delay);
  }

  async #checkHealth(): Promise<void> {
    let up: boolean;
    try {
      const response = await this.#api.healthz();
      up = response.body;
      this.#observe(response.date);
    } catch {
      up = false;
    }
    if (this.#disposed || this.#visibility.hidden() || this.#state.phase !== "disconnected") return;
    if (!up) {
      this.#scheduleHealthCheck();
      return;
    }
    this.#reconnect();
  }

  #visibilityChanged(): void {
    if (this.#disposed) return;
    if (this.#visibility.hidden()) {
      this.#stopStreamRetry();
      this.#closeStream();
      this.#clock.clearTimeout(this.#healthTimer);
      this.#healthTimer = undefined;
      return;
    }
    if (this.#state.phase === "disconnected") {
      this.#healthAttempt = 0;
      void this.#checkHealth();
      return;
    }
    this.#openStream();
  }
}

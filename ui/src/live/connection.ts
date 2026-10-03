/**
 * The console's live data (ADR 0013 §2 to §5): the routes the current screen reads, kept fresh by
 * the event stream and a one-second poll, and the state of the console's connection to the
 * daemon. Plain TypeScript with its clock, its visibility and its API injected, so every rule
 * here is tested as a function; `live-context.tsx` puts it behind React hooks.
 *
 * The rules, in one place:
 *
 * - Any event refetches every route the screen reads, at once, and so does a one-second poll.
 *   At most one request per route is in flight; calls that arrive meanwhile cause one more
 *   request after it, not one each.
 * - While the tab is hidden, the poll stops and the stream is closed. Shown again, the screen is
 *   refetched and the stream reopened.
 * - A request that fails at the network level or gives up after 10 seconds, a stream the daemon
 *   closes, and a stream silent for 40 seconds each mark the console disconnected. While
 *   disconnected nothing is polled and the stream stays closed; `/v1/healthz` is asked after 1,
 *   2, 4 and 8 seconds, then every 10. When it answers, the screen is refetched and the stream
 *   reopened, and the console says the daemon is starting until the daemon answers a read or
 *   opens the stream. A starting daemon holds both until it is ready, so while it is starting a
 *   request that gives up is sent again rather than counted as a loss. Each new loss starts the
 *   backoff from 1 second again, and so does a tab shown again while disconnected, which asks
 *   at once.
 * - A stream the console closed itself, hiding the tab or signing out, is not a loss.
 * - A request the daemon refuses is a fact about its route, not about the connection. A refused
 *   stream is asked for again with the next poll.
 */
import { ApiError, type ApiClient, type ApiPath, RequestTimeoutError } from "../api";
import { createSseParser, type SseMessage } from "./sse";
import { clockOffset } from "./time";

const POLL_INTERVAL_MS = 1_000;
/** More than two of the daemon's 15-second keepalives. */
const STREAM_SILENCE_MS = 40_000;
const HEALTHZ_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;
const HEALTHZ_INTERVAL_MS = 10_000;
const STREAM_PATH = "/v1/events/stream";

/** The time and timers, injected (the browser's in `browser.ts`, a fake one in tests). */
export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Whether the tab is hidden, and a way to hear when that changes. */
export interface Visibility {
  hidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export type LiveApi = Pick<ApiClient, "get" | "healthz" | "stream">;

/** What the console has for one route. */
export interface ResourceState<T> {
  /** The latest answer. Kept while a later request fails, so the screen keeps its data. */
  readonly data?: T;
  /** Why the latest request was refused; cleared by the next answer. */
  readonly error?: unknown;
}

/**
 * `connected`: reading and following the stream. `disconnected`: lost the daemon; waiting for
 * `/v1/healthz`. `starting`: `/v1/healthz` answered, and no read has yet.
 */
export type ConnectionPhase = "connected" | "disconnected" | "starting";

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  /**
   * Browser time of the latest answer to a read, which is how old the data on screen is. Set
   * only while not connected, and absent when no read has ever been answered.
   */
  readonly answeredAt?: number;
}

/** One event off the stream: its name, and its data parsed as JSON (`undefined` if it was not). */
export interface StreamEvent {
  readonly event: string;
  readonly data: unknown;
}

/** The stream opened. `closedForMs` is how long it was closed, absent the first time it opens. */
export interface StreamOpened {
  readonly closedForMs?: number;
}

interface Resource {
  state: ResourceState<unknown>;
  readonly listeners: Set<() => void>;
  inFlight: boolean;
  again: boolean;
}

export interface LiveConnectionOptions {
  readonly api: LiveApi;
  readonly clock: Clock;
  readonly visibility: Visibility;
}

export class LiveConnection {
  readonly #api: LiveApi;
  readonly #clock: Clock;
  readonly #visibility: Visibility;
  readonly #resources = new Map<ApiPath, Resource>();
  readonly #stateListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: StreamEvent) => void>();
  readonly #openListeners = new Set<(opened: StreamOpened) => void>();
  readonly #stopWatchingVisibility: () => void;
  #state: ConnectionState = { phase: "connected" };
  /** Browser time of the latest answer to a read. */
  #answeredAt: number | undefined;
  #offset = 0;
  #disposed = false;
  #pollTimer: unknown;
  #healthTimer: unknown;
  #healthAttempt = 0;
  #silenceTimer: unknown;
  /** The current stream's controller; aborting it closes the stream. */
  #stream: AbortController | undefined;
  #streamIsOpen = false;
  /** When an open stream last closed; `undefined` until one has been open. */
  #streamClosedAt: number | undefined;

  constructor(options: LiveConnectionOptions) {
    this.#api = options.api;
    this.#clock = options.clock;
    this.#visibility = options.visibility;
    this.#stopWatchingVisibility = this.#visibility.subscribe(() => this.#visibilityChanged());
    if (!this.#visibility.hidden()) {
      this.#openStream();
      this.#schedulePoll();
    }
  }

  /**
   * Marks `path` as a route the current screen reads, for as long as the returned function is
   * not called, and calls `listener` whenever what the console has for it changes. The first
   * watcher fetches it at once.
   */
  watch(path: ApiPath, listener: () => void): () => void {
    const resource = this.#resource(path);
    const first = resource.listeners.size === 0;
    resource.listeners.add(listener);
    if (first && this.#reading()) this.#fetch(path, resource);
    return () => {
      resource.listeners.delete(listener);
    };
  }

  /** What the console has for `path`. The same object until it changes. */
  resource<T>(path: ApiPath): ResourceState<T> {
    return this.#resource(path).state as ResourceState<T>;
  }

  /** The connection's state. The same object until it changes. */
  state(): ConnectionState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  /** The daemon's time now, by the browser's clock and the latest `Date` header. */
  serverNow(): number {
    return this.#clock.now() + this.#offset;
  }

  /** Every event the stream delivers, in order. */
  onEvent(listener: (event: StreamEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  /** Each time the stream opens, so a view can load what it missed while it was closed. */
  onStreamOpened(listener: (opened: StreamOpened) => void): () => void {
    this.#openListeners.add(listener);
    return () => {
      this.#openListeners.delete(listener);
    };
  }

  /** Signed out: close the stream, stop every timer, and ignore whatever is still in flight. */
  dispose(): void {
    this.#disposed = true;
    this.#stopWatchingVisibility();
    this.#stopPoll();
    this.#closeStream();
    this.#clock.clearTimeout(this.#healthTimer);
    this.#stateListeners.clear();
    this.#eventListeners.clear();
    this.#openListeners.clear();
  }

  #resource(path: ApiPath): Resource {
    let resource = this.#resources.get(path);
    if (resource === undefined) {
      resource = { again: false, inFlight: false, listeners: new Set(), state: {} };
      this.#resources.set(path, resource);
    }
    return resource;
  }

  /** Requests may be sent: signed in, the tab shown, and the daemon not lost. */
  #reading(): boolean {
    return !this.#disposed && !this.#visibility.hidden() && this.#state.phase !== "disconnected";
  }

  #refetchScreen(): void {
    for (const [path, resource] of this.#resources) {
      if (resource.listeners.size > 0) this.#fetch(path, resource);
    }
  }

  #fetch(path: ApiPath, resource: Resource): void {
    if (resource.inFlight) {
      resource.again = true;
      return;
    }
    resource.inFlight = true;
    this.#api.get(path).then(
      (response) => {
        resource.inFlight = false;
        if (this.#disposed) return;
        this.#observe(response.date);
        this.#answeredAt = this.#clock.now();
        this.#daemonAnswered();
        this.#update(resource, { data: response.body });
        this.#again(path, resource);
      },
      (error: unknown) => {
        resource.inFlight = false;
        if (this.#disposed) return;
        this.#failed(resource, error);
        this.#again(path, resource);
      },
    );
  }

  #again(path: ApiPath, resource: Resource): void {
    if (!resource.again) return;
    resource.again = false;
    if (this.#reading() && resource.listeners.size > 0) this.#fetch(path, resource);
  }

  #failed(resource: Resource, error: unknown): void {
    switch (this.#classify(error)) {
      case "refused": {
        // A fact about this route, not about the connection.
        this.#daemonAnswered();
        const { data } = resource.state;
        this.#update(resource, data === undefined ? { error } : { data, error });
        return;
      }
      case "retry":
        resource.again = true;
        return;
      case "lost":
        this.#lose();
    }
  }

  /**
   * What a failed request says about the daemon, for reads and the stream alike. `refused`: it
   * answered, with an error status or a body that is not JSON. `retry`: it is starting, and holds
   * every request until it is ready, so the request gave up waiting. `lost`: the request never
   * reached it or never came back.
   */
  #classify(error: unknown): "refused" | "retry" | "lost" {
    if (error instanceof ApiError || error instanceof SyntaxError) return "refused";
    if (error instanceof RequestTimeoutError && this.#state.phase === "starting") return "retry";
    return "lost";
  }

  #update(resource: Resource, state: ResourceState<unknown>): void {
    resource.state = state;
    for (const listener of resource.listeners) listener();
  }

  /** ADR 0013 §4: the latest response's `Date` header sets the clock offset. */
  #observe(date: string | null): void {
    const offset = clockOffset(date, this.#clock.now());
    if (offset !== undefined) this.#offset = offset;
  }

  /** The daemon answered a read or opened the stream. A starting daemon that answers is ready. */
  #daemonAnswered(): void {
    if (this.#state.phase !== "starting") return;
    this.#setState("connected");
    this.#schedulePoll();
  }

  /** Connected needs no age; the other two carry the age of the data on screen. */
  #setState(phase: ConnectionPhase): void {
    const answeredAt = this.#answeredAt;
    this.#state =
      phase === "connected" || answeredAt === undefined ? { phase } : { answeredAt, phase };
    for (const listener of this.#stateListeners) listener();
  }

  // ---- the poll ---------------------------------------------------------------------------

  #schedulePoll(): void {
    if (this.#pollTimer !== undefined) return;
    this.#pollTimer = this.#clock.setTimeout(() => {
      this.#pollTimer = undefined;
      if (!this.#reading() || this.#state.phase !== "connected") return;
      this.#refetchScreen();
      if (this.#stream === undefined) this.#openStream();
      this.#schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  #stopPoll(): void {
    this.#clock.clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  // ---- the stream -------------------------------------------------------------------------

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
    if (this.#streamIsOpen) this.#streamClosedAt = this.#clock.now();
    this.#streamIsOpen = false;
  }

  async #readStream(controller: AbortController): Promise<void> {
    const body = await this.#connectStream(controller);
    if (body === undefined) return;
    if (this.#stream !== controller) {
      // Closed while its headers were being handed over, by a loss or a hidden tab.
      void body.cancel().catch(() => undefined);
      return;
    }
    this.#streamOpened();
    const ended = await this.#follow(controller, body);
    // The daemon closed the stream, or it broke.
    if (ended) this.#lose();
  }

  /** The stream's body once its headers arrive; `undefined` when it did not open. */
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
        // Refused: the daemon is there. No stream for now; the next poll asks for one again.
        this.#stream = undefined;
        this.#daemonAnswered();
      }
      return undefined;
    }
  }

  /**
   * Reads the stream until it ends. `true` when the daemon ended it or it broke; `false` when
   * the console closed it.
   */
  async #follow(controller: AbortController, body: ReadableStream<Uint8Array>): Promise<boolean> {
    const reader = body.getReader();
    const parser = createSseParser();
    this.#watchSilence(controller);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.#stream !== controller) return false;
        if (done) return true;
        this.#watchSilence(controller);
        for (const message of parser.push(value)) this.#deliver(message);
      }
    } catch {
      return this.#stream === controller;
    }
  }

  #streamOpened(): void {
    this.#streamIsOpen = true;
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
    if (this.#reading()) this.#refetchScreen();
  }

  // ---- losing and finding the daemon ------------------------------------------------------

  #lose(): void {
    if (this.#disposed || this.#state.phase === "disconnected") return;
    this.#stopPoll();
    this.#closeStream();
    this.#setState("disconnected");
    this.#healthAttempt = 0;
    if (!this.#visibility.hidden()) this.#scheduleHealthCheck();
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
    this.#setState("starting");
    this.#refetchScreen();
    this.#openStream();
  }

  // ---- the tab ----------------------------------------------------------------------------

  #visibilityChanged(): void {
    if (this.#disposed) return;
    if (this.#visibility.hidden()) {
      this.#stopPoll();
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
    this.#refetchScreen();
    this.#openStream();
    if (this.#state.phase === "connected") this.#schedulePoll();
  }
}

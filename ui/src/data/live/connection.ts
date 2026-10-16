import { ApiError, type ApiClient, type ApiPath, RequestTimeoutError } from "../api";
import { createSseParser, type SseMessage } from "./sse";
import { clockOffset } from "./clock";

const POLL_INTERVAL_MS = 1_000;
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

export function isRefusal(error: unknown): boolean {
  return error instanceof ApiError || error instanceof SyntaxError;
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
  #answeredAt: number | undefined;
  #offset = 0;
  #disposed = false;
  #pollTimer: unknown;
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
    this.#stopWatchingVisibility = this.#visibility.subscribe(() => this.#visibilityChanged());
    if (!this.#visibility.hidden()) {
      this.#openStream();
      this.#schedulePoll();
    }
  }

  watch(path: ApiPath, listener: () => void): () => void {
    const resource = this.#resource(path);
    const first = resource.listeners.size === 0;
    resource.listeners.add(listener);
    if (first && this.#reading()) this.#fetch(path, resource);
    return () => {
      resource.listeners.delete(listener);
    };
  }

  resource<T>(path: ApiPath): ResourceState<T> {
    return this.#resource(path).state as ResourceState<T>;
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
        // why: a fact about this route, not about the connection.
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

  // why: a starting daemon holds every request until it is ready, so a request that gave up waiting
  // (`retry`) is sent again instead of counted as a loss.
  #classify(error: unknown): "refused" | "retry" | "lost" {
    if (isRefusal(error)) return "refused";
    if (error instanceof RequestTimeoutError && this.#state.phase === "starting") return "retry";
    return "lost";
  }

  #update(resource: Resource, state: ResourceState<unknown>): void {
    resource.state = state;
    for (const listener of resource.listeners) listener();
  }

  #observe(date: string | null): void {
    const offset = clockOffset(date, this.#clock.now());
    if (offset !== undefined) this.#offset = offset;
  }

  #daemonAnswered(): void {
    if (this.#state.phase !== "starting") return;
    this.#setState("connected");
    this.#schedulePoll();
  }

  #setState(phase: ConnectionPhase): void {
    const answeredAt = this.#answeredAt;
    this.#state =
      phase === "connected" || answeredAt === undefined ? { phase } : { answeredAt, phase };
    for (const listener of this.#stateListeners) listener();
  }

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
        // why: refused means the daemon is there: no stream for now, and the next poll asks for one
        // again.
        this.#stream = undefined;
        this.#daemonAnswered();
      }
      return undefined;
    }
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
    if (this.#reading()) this.#refetchScreen();
  }

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

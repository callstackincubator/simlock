import { ApiError, type ApiPath } from "./api";
import {
  type Clock,
  isRefusal,
  type ResourceState,
  type StreamEvent,
  type StreamOpened,
} from "./live/connection";
import {
  type ConsoleEvent,
  type HistoryState,
  MAX_EVENTS,
  mergeEvents,
  OLDER_PAGE as PAGE,
  readEvent,
  readOlder,
  readReplay,
  RECENT,
  sinceFor,
} from "../model/events";

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;
const RETRY_INTERVAL_MS = 10_000;

export class EventFeed {
  readonly #get: (path: ApiPath) => Promise<unknown>;
  readonly #clock: Clock;
  readonly #listeners = new Set<() => void>();
  #events: readonly ConsoleEvent[] = [];
  #state: ResourceState<readonly ConsoleEvent[]> = {};
  #settled = false;
  #needRecent = true;
  #gapFrom: number | undefined;
  #loading = false;
  #loadingOlder = false;
  #history: HistoryState = "more";
  // why: counts the stream's opens, so a load knows whether one happened while it was out.
  #opens = 0;
  #retryTimer: unknown;
  #retryAttempt = 0;
  #active = false;

  readonly #showsHistory: boolean;

  // why: only a screen that scrolls back through the history asks for it; the others read the last
  // hour and nothing older, so a quiet hour does not fill their lists with older events.
  constructor(get: (path: ApiPath) => Promise<unknown>, clock: Clock, showsHistory = false) {
    this.#get = get;
    this.#clock = clock;
    this.#showsHistory = showsHistory;
  }

  start(): () => void {
    this.#active = true;
    this.#loadMissing();
    return () => {
      this.#active = false;
    };
  }

  readonly streamEvent = (message: StreamEvent): void => {
    if (!this.#active) return;
    const event = readEvent(message.data);
    if (event !== undefined) this.#add([event]);
  };

  readonly streamOpened = (opened: StreamOpened): void => {
    const gap = opened.closedForMs;
    if (gap === undefined) this.#needRecent = true;
    else {
      const from = this.#clock.now() - gap;
      this.#gapFrom = Math.min(this.#gapFrom ?? from, from);
    }
    this.#opens += 1;
    this.#retryAttempt = 0;
    this.#loadMissing();
  };

  readonly snapshot = (): ResourceState<readonly ConsoleEvent[]> => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #since(): string | undefined {
    if (this.#needRecent) return RECENT;
    return this.#gapFrom === undefined ? undefined : sinceFor(this.#clock.now() - this.#gapFrom);
  }

  #loadMissing(): void {
    const since = this.#since();
    if (!this.#active || this.#loading || since === undefined) return;
    this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#loading = true;
    const opens = this.#opens;
    this.#get(`/v1/events?since=${since}`)
      .then(readReplay)
      .then(
        (events) => {
          this.#loading = false;
          if (!this.#active) return;
          if (opens === this.#opens) {
            this.#needRecent = false;
            this.#gapFrom = undefined;
          }
          this.#retryAttempt = 0;
          this.#settled = true;
          this.#events = mergeEvents(this.#events, events);
          this.#publish({ data: this.#events });
          this.#loadMissing();
          // why: a quiet last hour still shows the older history, so the newest page is asked for at once.
          if (this.#showsHistory && this.#events.length === 0) this.loadOlder();
        },
        (error: unknown) => {
          this.#loading = false;
          if (!this.#active) return;
          if (!isRefusal(error)) {
            this.#retryLater();
            return;
          }
          this.#settled = true;
          this.#publish({ data: this.#events, error });
          // why: a refused last hour still leaves the older history to show, so it is asked for as for an empty one.
          if (this.#showsHistory && this.#events.length === 0) this.loadOlder();
        },
      );
  }

  readonly history = (): HistoryState => this.#history;

  // why: one page at a time, none once the history has ended, and none at the cap: a second signal
  // before the answer is dropped.
  readonly loadOlder = (): void => {
    if (!this.#active || this.#loadingOlder || this.#events.length >= MAX_EVENTS) return;
    if (this.#history !== "more" && this.#history !== "failed") return;
    const oldest = this.#events.at(-1);
    const query =
      oldest === undefined
        ? `limit=${PAGE}`
        : `before=${encodeURIComponent(oldest.id)}&limit=${PAGE}`;
    this.#loadingOlder = true;
    this.#get(`/v1/events?${query}`)
      .then(readOlder)
      .then(
        (page) => {
          this.#loadingOlder = false;
          if (!this.#active) return;
          const current = this.#events;
          this.#events = mergeEvents(current, page.events);
          this.#setHistory(page.full && this.#events !== current ? "more" : "start");
        },
        (error: unknown) => {
          this.#loadingOlder = false;
          if (!this.#active) return;
          this.#setHistory(error instanceof ApiError && error.status === 422 ? "gone" : "failed");
        },
      );
  };

  #setHistory(history: HistoryState): void {
    this.#history = history;
    this.#publish({ ...this.#state, data: this.#events });
  }

  #retryLater(): void {
    const delay = RETRY_BACKOFF_MS[this.#retryAttempt] ?? RETRY_INTERVAL_MS;
    this.#retryAttempt += 1;
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = undefined;
      this.#loadMissing();
    }, delay);
  }

  #add(incoming: readonly ConsoleEvent[]): void {
    const merged = mergeEvents(this.#events, incoming);
    if (merged === this.#events) return;
    this.#events = merged;
    if (this.#settled) this.#publish({ ...this.#state, data: merged });
  }

  #publish(state: ResourceState<readonly ConsoleEvent[]>): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

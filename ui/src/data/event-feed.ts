import type { ApiPath } from "./api";
import {
  type Clock,
  isRefusal,
  type ResourceState,
  type StreamEvent,
  type StreamOpened,
} from "./live/connection";
import {
  type ConsoleEvent,
  mergeEvents,
  readEvent,
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
  // why: counts the stream's opens, so a load knows whether one happened while it was out.
  #opens = 0;
  #retryTimer: unknown;
  #retryAttempt = 0;
  #active = false;

  constructor(get: (path: ApiPath) => Promise<unknown>, clock: Clock) {
    this.#get = get;
    this.#clock = clock;
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
        },
      );
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

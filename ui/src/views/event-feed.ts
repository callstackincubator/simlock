/**
 * The events view's list, filled as ADR 0013 §2 and §5 say: the stream's events as they come,
 * and `GET /v1/events` for what came before, each event once. Plain TypeScript, so the fill is
 * tested against the real live connection on a scripted daemon; `events.tsx` wires it to the
 * stream with `useLiveEvents` and `useStreamOpened`.
 *
 * The feed keeps track of what may be missing, and loads until nothing is:
 *
 * - The last hour, as `simlock events --since 1h` shows, until a load of it answers. The view
 *   opening asks for it, and so does the stream's first open: a view opened before the stream
 *   loads once more after it, so nothing sent between the two is lost.
 * - A gap: each time the stream opens again, after a lost daemon or a hidden tab, everything
 *   since the console last heard from the stream. It is asked for as `since` that long, in whole
 *   seconds, rounded up. Gaps not yet loaded add up: the load covers from the earliest.
 *
 * A load clears what was missing only if the stream did not open again while it was out: what
 * the stream missed meanwhile may be newer than the load's answer, so the feed loads again.
 *
 * One load at a time. A load that does not reach the daemon is sent again after 1, 2, 4 and 8
 * seconds, then every 10, and shows nothing of its own: the connection banner says when the
 * daemon is lost. A load the daemon refuses shows why, above the events already shown, and is
 * asked for again when the stream next opens.
 */
import type { ApiPath } from "../api";
import {
  type Clock,
  isRefusal,
  type ResourceState,
  type StreamEvent,
  type StreamOpened,
} from "../live/connection";
import {
  type ConsoleEvent,
  mergeEvents,
  readEvent,
  readReplay,
  RECENT,
  sinceFor,
} from "./events-model";

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;
const RETRY_INTERVAL_MS = 10_000;

export class EventFeed {
  readonly #get: (path: ApiPath) => Promise<unknown>;
  readonly #clock: Clock;
  readonly #listeners = new Set<() => void>();
  #events: readonly ConsoleEvent[] = [];
  #state: ResourceState<readonly ConsoleEvent[]> = {};
  /** Whether a load has answered or been refused; until then the view says it is loading. */
  #settled = false;
  /** Whether the last hour still has to be loaded. */
  #needRecent = true;
  /** The browser time from which events may be missing; `undefined` when none are. */
  #gapFrom: number | undefined;
  #loading = false;
  /** Counts the stream's opens, so a load knows whether one happened while it was out. */
  #opens = 0;
  #retryTimer: unknown;
  #retryAttempt = 0;
  #active = false;

  /** `get` reads a route and resolves its JSON body. */
  constructor(get: (path: ApiPath) => Promise<unknown>, clock: Clock) {
    this.#get = get;
    this.#clock = clock;
  }

  /** The view opened: load the recent events. Returns the function that stops the feed. */
  start(): () => void {
    this.#active = true;
    this.#loadMissing();
    return () => {
      this.#active = false;
    };
  }

  /** An event off the stream. Not an event envelope: ignored. */
  readonly streamEvent = (message: StreamEvent): void => {
    if (!this.#active) return;
    const event = readEvent(message.data);
    if (event !== undefined) this.#add([event]);
  };

  /** The stream opened: load what it may have missed. */
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

  /**
   * The events, newest first, once a load has settled. `error` is why the latest load was
   * refused, cleared by the next that answers. The same object until it changes.
   */
  readonly snapshot = (): ResourceState<readonly ConsoleEvent[]> => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The `since` that covers everything missing now, or `undefined` when nothing is. */
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

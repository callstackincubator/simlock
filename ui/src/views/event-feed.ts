/**
 * The events view's list, filled as ADR 0013 §2 and §5 say: the stream's events as they come,
 * and `GET /v1/events` for what came before, each event once. Plain TypeScript, so the fill is
 * tested against the real live connection on a scripted daemon; `events.tsx` wires it to the
 * stream with `useLiveEvents` and `useStreamOpened`.
 *
 * When it loads:
 *
 * - The view opens: the last hour, as `simlock events --since 1h` shows.
 * - The stream opens: what it may have missed. Until the last hour has loaded once, that is the
 *   last hour again: the stream's first open after a view opened before it, or a view opened
 *   while the daemon was away. After that, `since` how long the console had not heard from the
 *   stream, in whole seconds, rounded up.
 *
 * A load the daemon refuses shows why, above the events already shown. A load that does not
 * reach the daemon shows nothing of its own: the connection says the daemon is lost, and the
 * stream opening again loads what was missed.
 */
import type { ApiPath } from "../api";
import {
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

export class EventFeed {
  readonly #get: (path: ApiPath) => Promise<unknown>;
  readonly #listeners = new Set<() => void>();
  #events: readonly ConsoleEvent[] = [];
  #state: ResourceState<readonly ConsoleEvent[]> = {};
  /** Whether a load has answered or been refused; until then the view says it is loading. */
  #settled = false;
  /** Whether a load has answered. Every load until then is the last hour, so after it only a gap can be missing. */
  #recentLoaded = false;
  #active = false;

  /** `get` reads a route and resolves its JSON body. */
  constructor(get: (path: ApiPath) => Promise<unknown>) {
    this.#get = get;
  }

  /** The view opened: load the recent events. Returns the function that stops the feed. */
  start(): () => void {
    this.#active = true;
    this.#load(RECENT);
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
    if (!this.#active) return;
    const gap = opened.closedForMs;
    this.#load(gap === undefined || !this.#recentLoaded ? RECENT : sinceFor(gap));
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

  #load(since: string): void {
    this.#get(`/v1/events?since=${since}`)
      .then(readReplay)
      .then(
        (events) => {
          if (!this.#active) return;
          this.#recentLoaded = true;
          this.#settled = true;
          this.#events = mergeEvents(this.#events, events);
          this.#publish({ data: this.#events });
        },
        (error: unknown) => {
          if (!this.#active || !isRefusal(error)) return;
          this.#settled = true;
          this.#publish({ data: this.#events, error });
        },
      );
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

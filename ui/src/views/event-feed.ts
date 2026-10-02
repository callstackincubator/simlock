/**
 * The events view's list, filled as ADR 0013 §2 and §5 say: the stream's events as they come,
 * and `GET /v1/events` for what came before, each event once. Plain TypeScript, so the fill is
 * tested against the real live connection on a scripted daemon; `events.tsx` wires it to the
 * stream with `useLiveEvents` and `useStreamOpened`.
 *
 * When it loads:
 *
 * - The view opens: the last hour, as `simlock events --since 1h` shows.
 * - The stream opens for the first time: the last hour again. A view opened before the stream
 *   did loads once more after it, so nothing sent between the first load and the stream is lost.
 * - The stream opens again, after a lost daemon or a hidden tab: `since` how long it was closed,
 *   in whole seconds, rounded up.
 */
import type { ApiPath } from "../api";
import type { ResourceState, StreamEvent, StreamOpened } from "../live/connection";
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
  /** Whether any load has answered or failed; until then the view says it is loading. */
  #settled = false;
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
    this.#load(opened.closedForMs === undefined ? RECENT : sinceFor(opened.closedForMs));
  };

  /**
   * The events, newest first, once a load has settled. `error` is why the latest load failed,
   * cleared by the next that answers. The same object until it changes.
   */
  readonly snapshot = (): ResourceState<readonly ConsoleEvent[]> => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #load(since: string): void {
    this.#get(`/v1/events?since=${since}`).then(
      (body) => {
        if (!this.#active) return;
        let events: readonly ConsoleEvent[];
        try {
          events = readReplay(body);
        } catch (error: unknown) {
          this.#fail(error);
          return;
        }
        this.#settled = true;
        this.#events = mergeEvents(this.#events, events);
        this.#publish({ data: this.#events });
      },
      (error: unknown) => {
        if (this.#active) this.#fail(error);
      },
    );
  }

  #add(incoming: readonly ConsoleEvent[]): void {
    const merged = mergeEvents(this.#events, incoming);
    if (merged === this.#events) return;
    this.#events = merged;
    if (this.#settled) this.#publish({ ...this.#state, data: merged });
  }

  #fail(error: unknown): void {
    this.#settled = true;
    this.#publish({ data: this.#events, error });
  }

  #publish(state: ResourceState<readonly ConsoleEvent[]>): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

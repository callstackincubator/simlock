import type { ApiPath } from "./api";
import { EventFeed } from "./event-feed";
import type { Clock, LiveConnection, ResourceState } from "./live/connection";
import type { ConsoleEvent } from "../model/events";

// why: ADR 0044 §1: what no page uses stays a minute, so going back to a drawer shows it at once.
const KEEP_MS = 60_000;

export interface RecentFeed {
  readonly acquire: () => () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ResourceState<readonly ConsoleEvent[]>;
}

const NOTHING: ResourceState<readonly ConsoleEvent[]> = {};

// why: one feed of the last hour per tab, shared by every drawer that lists events. It starts at
// the first user, holds the stream while any user or the last minute keeps it, and is dropped after.
export function createRecentFeed(options: {
  readonly get: (path: ApiPath) => Promise<unknown>;
  readonly clock: Clock;
  readonly connection: LiveConnection;
}): RecentFeed {
  const { clock, connection, get } = options;
  const listeners = new Set<() => void>();
  let kept: { readonly feed: EventFeed; readonly stop: () => void } | undefined;
  let users = 0;
  let dropTimer: unknown;
  const changed = (): void => {
    for (const listener of listeners) listener();
  };
  const start = (): void => {
    const feed = new EventFeed(get, clock);
    const stops = [
      feed.subscribe(changed),
      connection.onEvent(feed.streamEvent),
      connection.onStreamOpened(feed.streamOpened),
      feed.start(),
    ];
    kept = {
      feed,
      stop: () => {
        for (const stop of stops) stop();
      },
    };
  };
  const drop = (): void => {
    kept?.stop();
    kept = undefined;
    changed();
  };
  return {
    acquire() {
      clock.clearTimeout(dropTimer);
      users += 1;
      if (kept === undefined) start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        users -= 1;
        if (users === 0) dropTimer = clock.setTimeout(drop, KEEP_MS);
      };
    },
    snapshot: () => kept?.feed.snapshot() ?? NOTHING,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

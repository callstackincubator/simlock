/**
 * The live data layer behind React hooks. The shell mounts one `LiveProvider` while the operator
 * is signed in; unmounting it, as signing out does, closes the stream and stops every timer.
 *
 * A view reads a route with `useLiveResource(path)`: while the view is on screen, that route is
 * one "the current screen reads", refetched on every event and every second (ADR 0013 §3).
 * `useNow()` ticks once a second for durations, and `useConnection()` is what the banner shows.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  useContext,
  useSyncExternalStore,
} from "react";

import type { ApiPath } from "../api";
import { useApi } from "../console-context";
import { browserClock, documentVisibility } from "./browser";
import {
  type Clock,
  type ConnectionState,
  LiveConnection,
  type ResourceState,
  type StreamEvent,
  type StreamOpened,
} from "./connection";

/** The browser's time and the daemon's, at the latest tick. */
export interface Now {
  readonly browser: number;
  readonly server: number;
}

interface Live {
  readonly connection: LiveConnection;
  readonly ticker: Ticker;
}

const LiveContext = createContext<Live | undefined>(undefined);

export function LiveProvider({ children }: { readonly children: ReactNode }) {
  const api = useApi();
  const [live, setLive] = useState<Live | undefined>(undefined);
  useEffect(() => {
    const connection = new LiveConnection({
      api,
      clock: browserClock,
      visibility: documentVisibility,
    });
    const ticker = createTicker(browserClock, () => connection.serverNow());
    setLive({ connection, ticker });
    return () => {
      ticker.dispose();
      connection.dispose();
    };
  }, [api]);
  if (live === undefined) return null;
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

function useLive(): Live {
  const live = useContext(LiveContext);
  if (live === undefined) throw new Error("Live data used outside LiveProvider");
  return live;
}

/** What the console has for `path`, kept fresh while the calling view is on screen. */
export function useLiveResource<T>(path: ApiPath): ResourceState<T> {
  const { connection } = useLive();
  const subscribe = useCallback(
    (listener: () => void) => connection.watch(path, listener),
    [connection, path],
  );
  const snapshot = useCallback(() => connection.resource<T>(path), [connection, path]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function useConnection(): ConnectionState {
  const { connection } = useLive();
  return useSyncExternalStore(
    useCallback((listener: () => void) => connection.subscribe(listener), [connection]),
    useCallback(() => connection.state(), [connection]),
  );
}

/** Now, by the browser and by the daemon, re-rendering once a second (ADR 0013 §4). */
export function useNow(): Now {
  const { ticker } = useLive();
  return useSyncExternalStore(ticker.subscribe, ticker.now);
}

/** Calls `listener` for every event the stream delivers while the calling view is on screen. */
export function useLiveEvents(listener: (event: StreamEvent) => void): void {
  const { connection } = useLive();
  useEffect(() => connection.onEvent(listener), [connection, listener]);
}

/**
 * Calls `listener` each time the stream opens, with how long it was closed, so a view can load
 * what it missed (ADR 0013 §2, §5).
 */
export function useStreamOpened(listener: (opened: StreamOpened) => void): void {
  const { connection } = useLive();
  useEffect(() => connection.onStreamOpened(listener), [connection, listener]);
}

interface Ticker {
  readonly subscribe: (listener: () => void) => () => void;
  readonly now: () => Now;
  readonly dispose: () => void;
}

/**
 * One timer for every duration on screen, running while anything reads it. The connection
 * banner does, on every signed-in page, for the data's age.
 */
function createTicker(clock: Clock, serverNow: () => number): Ticker {
  const listeners = new Set<() => void>();
  const read = (): Now => ({ browser: clock.now(), server: serverNow() });
  let current = read();
  let timer: unknown;
  const tick = () => {
    current = read();
    for (const listener of listeners) listener();
    timer = clock.setTimeout(tick, 1_000);
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        current = read();
        timer = clock.setTimeout(tick, 1_000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) clock.clearTimeout(timer);
      };
    },
    now: () => current,
    dispose: () => {
      listeners.clear();
      clock.clearTimeout(timer);
    },
  };
}

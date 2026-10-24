import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  useContext,
  useSyncExternalStore,
} from "react";

import { useQuery } from "@tanstack/react-query";

import type { ApiPath } from "../data/api";
import { createRecentFeed, type RecentFeed } from "../data/recent-feed";
import { type DaemonFacts, type DaemonMode, type ModeStore, watchMode } from "../data/mode";
import { useApi, useSession } from "./services";
import { createQueries, type Queries, resourceOf } from "./queries";
import { browserClock, documentVisibility } from "../data/live/browser";
import {
  type Clock,
  type ConnectionState,
  LiveConnection,
  type ResourceState,
  type StreamEvent,
  type StreamOpened,
} from "../data/live/connection";

export interface Now {
  readonly browser: number;
  readonly server: number;
}

export interface Live {
  readonly connection: LiveConnection;
  readonly mode: ModeStore;
  readonly queries: Queries;
  // why: the last hour of events, read once for every drawer of the tab that shows them.
  readonly recent: RecentFeed;
  readonly ticker: Ticker;
}

// why: exported so a screen test can stand in a fixed daemon mode without a connection.
export const LiveContext = createContext<Live | undefined>(undefined);

export function LiveProvider({ children }: { readonly children: ReactNode }) {
  const api = useApi();
  const session = useSession();
  const [live, setLive] = useState<Live | undefined>(undefined);
  useEffect(() => {
    const connection = new LiveConnection({
      api,
      clock: browserClock,
      visibility: documentVisibility,
      whenLost: session.lost,
    });
    const ticker = createTicker(browserClock, () => connection.serverNow());
    const mode = watchMode({ api, clock: browserClock, connection });
    const queries = createQueries({
      clock: browserClock,
      connection,
      visibility: documentVisibility,
    });
    const recent = createRecentFeed({
      clock: browserClock,
      connection,
      get: (path) => api.getJson(path),
    });
    setLive({ connection, mode, queries, recent, ticker });
    return () => {
      queries.dispose();
      mode.dispose();
      ticker.dispose();
      connection.dispose();
    };
  }, [api, session]);
  if (live === undefined) return null;
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

function useLive(): Live {
  const live = useContext(LiveContext);
  if (live === undefined) throw new Error("Live data used outside LiveProvider");
  return live;
}

export function useRouteQuery<T>(path: ApiPath): ResourceState<T> {
  const { queries } = useLive();
  return resourceOf(useQuery(queries.options<T>(path), queries.client));
}

// why: `undefined` until a read of `GET /v1/status` has said which kind of daemon this is.
export function useDaemonMode(): DaemonMode | undefined {
  const { mode } = useLive();
  return useSyncExternalStore(mode.subscribe, mode.mode, mode.mode);
}

// why: the version the daemon runs and the latest it knows, for the sidebar's notice.
export function useDaemonFacts(): DaemonFacts {
  const { mode } = useLive();
  return useSyncExternalStore(mode.subscribe, mode.daemon, mode.daemon);
}

export function useRecentFeed(): RecentFeed {
  return useLive().recent;
}

export function useConnection(): ConnectionState {
  const { connection } = useLive();
  return useSyncExternalStore(
    useCallback((listener: () => void) => connection.subscribe(listener), [connection]),
    useCallback(() => connection.state(), [connection]),
  );
}

export function useNow(): Now {
  const { ticker } = useLive();
  return useSyncExternalStore(ticker.subscribe, ticker.now);
}

export function useLiveEvents(listener: (event: StreamEvent) => void): void {
  const { connection } = useLive();
  useEffect(() => connection.onEvent(listener), [connection, listener]);
}

export function useStreamOpened(listener: (opened: StreamOpened) => void): void {
  const { connection } = useLive();
  useEffect(() => connection.onStreamOpened(listener), [connection, listener]);
}

interface Ticker {
  readonly subscribe: (listener: () => void) => () => void;
  readonly now: () => Now;
  readonly dispose: () => void;
}

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

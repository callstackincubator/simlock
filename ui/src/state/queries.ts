import {
  focusManager,
  onlineManager,
  type Query,
  QueryClient,
  type QueryObserverOptions,
} from "@tanstack/react-query";

import type { ApiPath } from "../data/api";
import {
  type Clock,
  ConnectionLost,
  type LiveConnection,
  type ResourceState,
  type StreamEvent,
  type Visibility,
} from "../data/live/connection";
import { type StaleKey, staleKeys } from "../model/stale-keys";

// why: data no page uses stays a minute, so going back to a page shows it at once.
const DROP_MS = 60_000;
const FRESH_MS = 2_000;
// why: events of one change come in a run, so a read waits until the run has been quiet this long,
// but never more than the cap after the first, and is sent once more later for a change that
// landed after the first answer was made.
const QUIET_MS = 300;
const CAP_MS = 1_000;
const AGAIN_MS = 1_500;

interface Times {
  readonly pollMs?: number;
  readonly freshMs: number;
}

const TIMES: Readonly<Record<string, Times>> = {
  inbox: { freshMs: FRESH_MS, pollMs: 10_000 },
  lease: { freshMs: FRESH_MS, pollMs: 10_000 },
  "lease-requests": { freshMs: FRESH_MS, pollMs: 5_000 },
  leases: { freshMs: FRESH_MS, pollMs: 10_000 },
  stats: { freshMs: 30_000, pollMs: 60_000 },
  tokens: { freshMs: 300_000 },
  workers: { freshMs: FRESH_MS, pollMs: 15_000 },
};

const DEFAULT_TIMES: Times = { freshMs: FRESH_MS };

export interface QueriesOptions {
  readonly connection: LiveConnection;
  readonly clock: Clock;
  readonly visibility: Visibility;
}

export interface Queries {
  readonly client: QueryClient;
  options<T>(path: ApiPath): QueryObserverOptions<T>;
  dispose(): void;
}

// why: the key a route is cached under: its name, and for one lease or one stats range the id or
// range after it.
export function routeKey(path: ApiPath): readonly string[] {
  const [route = "", search = ""] = path.slice("/v1/".length).split("?");
  const [head = "", id] = route.split("/");
  if (head === "stats") return ["stats", new URLSearchParams(search).get("since") ?? ""];
  if (head === "leases" && id !== undefined) return ["lease", decodeURIComponent(id)];
  return [head];
}

// why: a read lost to the network is the connection's loss, which the sidebar says; the page keeps
// its data, or its loading, and shows no error for it.
export function resourceOf<T>(result: {
  readonly data: T | undefined;
  readonly error: unknown;
}): ResourceState<T> {
  const { data, error } = result;
  const refusal = error instanceof ConnectionLost ? undefined : error;
  return {
    ...(data === undefined ? {} : { data }),
    ...(refusal === undefined || refusal === null ? {} : { error: refusal }),
  };
}

function timesOf(key: readonly unknown[]): Times {
  return TIMES[String(key[0])] ?? DEFAULT_TIMES;
}

export function createQueries({ clock, connection, visibility }: QueriesOptions): Queries {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: DROP_MS,
        refetchOnReconnect: "always",
        refetchOnWindowFocus: "always",
        retry: false,
      },
    },
  });
  // why: the browser's own focus and online events would fight the connection's view of both.
  focusManager.setEventListener(() => () => undefined);
  onlineManager.setEventListener(() => () => undefined);
  focusManager.setFocused(!visibility.hidden());
  onlineManager.setOnline(connection.state().phase !== "disconnected");
  const stopVisibility = visibility.subscribe(() => focusManager.setFocused(!visibility.hidden()));
  const stopConnection = connection.subscribe(() =>
    onlineManager.setOnline(connection.state().phase !== "disconnected"),
  );
  client.mount();

  // why: one poll timer per key, not per page using it, so two pages on one key do not read twice.
  const polls = new Map<string, unknown>();
  const stopPoll = (hash: string): void => {
    clock.clearTimeout(polls.get(hash));
    polls.delete(hash);
  };
  const schedulePoll = (query: Query): void => {
    stopPoll(query.queryHash);
    const { pollMs } = timesOf(query.queryKey);
    if (pollMs === undefined || query.getObserversCount() === 0) return;
    polls.set(
      query.queryHash,
      clock.setTimeout(() => {
        polls.delete(query.queryHash);
        if (visibility.hidden() || !onlineManager.isOnline()) return;
        // why: a read already in flight answers this poll too, so it is not cancelled and sent again.
        void client.refetchQueries(
          { exact: true, queryKey: query.queryKey, type: "active" },
          { cancelRefetch: false },
        );
      }, pollMs),
    );
  };
  const stopCache = client.getQueryCache().subscribe((event) => {
    if (event.type === "observerAdded" || event.type === "observerRemoved") {
      schedulePoll(event.query);
    } else if (
      event.type === "updated" &&
      (event.action.type === "success" || event.action.type === "error")
    ) {
      schedulePoll(event.query);
    }
  });

  const marked = new Map<string, StaleKey>();
  const again = new Map<string, StaleKey>();
  let quietTimer: unknown;
  let capTimer: unknown;
  let againTimer: unknown;
  const readMarked = (keys: ReadonlyMap<string, StaleKey>): void => {
    // why: a hidden tab or a lost connection reads nothing; coming back reads each key on screen once.
    if (visibility.hidden() || !onlineManager.isOnline()) return;
    for (const queryKey of keys.values()) {
      void client.refetchQueries({ queryKey, type: "active" }, { cancelRefetch: false });
    }
  };
  const flush = (): void => {
    clock.clearTimeout(quietTimer);
    clock.clearTimeout(capTimer);
    quietTimer = undefined;
    capTimer = undefined;
    const keys = new Map(marked);
    marked.clear();
    readMarked(keys);
    for (const [hash, key] of keys) again.set(hash, key);
    clock.clearTimeout(againTimer);
    againTimer = clock.setTimeout(() => {
      againTimer = undefined;
      const later = new Map(again);
      again.clear();
      readMarked(later);
    }, AGAIN_MS);
  };
  const stopEvents = connection.onEvent((event: StreamEvent) => {
    const { data } = event;
    const payload =
      typeof data === "object" && data !== null
        ? (data as { payload?: unknown }).payload
        : undefined;
    const keys = staleKeys(event.event, payload);
    if (keys.length === 0) return;
    for (const queryKey of keys) {
      marked.set(queryKey.join("/"), queryKey);
      void client.invalidateQueries({ queryKey, refetchType: "none" });
    }
    clock.clearTimeout(quietTimer);
    quietTimer = clock.setTimeout(flush, QUIET_MS);
    capTimer ??= clock.setTimeout(flush, CAP_MS);
  });

  return {
    client,
    dispose: () => {
      stopEvents();
      clock.clearTimeout(quietTimer);
      clock.clearTimeout(capTimer);
      clock.clearTimeout(againTimer);
      stopCache();
      for (const hash of polls.keys()) stopPoll(hash);
      stopVisibility();
      stopConnection();
      client.unmount();
      client.clear();
    },
    options: <T>(path: ApiPath): QueryObserverOptions<T> => ({
      queryFn: () => connection.read<T>(path),
      queryKey: routeKey(path),
      staleTime: timesOf(routeKey(path)).freshMs,
    }),
  };
}

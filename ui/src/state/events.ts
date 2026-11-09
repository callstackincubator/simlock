import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { EventFeed } from "../data/event-feed";
import { browserClock } from "../data/live/browser";
import type { ResourceState } from "../data/live/connection";
import type { LoadView } from "../ds/loaded";
import { type Chosen, chosenEvent, type EventDetail, type EventsChart } from "../model/event-list";
import {
  type ActivityFilter,
  type ActivityRow,
  activityView,
  coverageText,
  type Facets,
  type Kind,
  readFilter,
  toggleKind,
  toggleProblems,
  toggleWorker,
  writeFilter,
} from "../model/activity-view";
import { type ConsoleRange, readRange } from "../model/range";
import { useSettings } from "./settings";
import { type ConsoleEvent, type HistoryEnd, type HistoryState, historyEnd } from "../model/events";
import { readQuery, writeQuery } from "../model/paging";
import type { LeaseList, LeaseRecord } from "../model/leases";
import { itemIdFrom } from "../model/paths";
import type { WaitingList, WaitingRequest } from "../model/waiting";
import type { WorkerList, WorkerView } from "../model/workers";
import { useLiveEvents, useRecentFeed, useRouteQuery, useNow, useStreamOpened } from "./live";
import { loadView, mapView } from "./resource";
import { setSearch, usePath, useSearch } from "./router";
import { useApi } from "./services";

export type {
  ActivityFilter,
  ActivityRow,
  Chosen,
  EventDetail,
  EventsChart,
  Facets,
  HistoryEnd,
  Kind,
};

// why: Activity holds its own feed with history, filled from the last hour and then the stream
// while it is on screen.
function useEventFeed(): {
  readonly feed: EventFeed;
  readonly state: ResourceState<readonly ConsoleEvent[]>;
  readonly history: HistoryState;
} {
  const api = useApi();
  const [feed] = useState(() => new EventFeed((path) => api.getJson(path), browserClock, true));
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  return {
    feed,
    history: useSyncExternalStore(feed.subscribe, feed.history),
    state: useSyncExternalStore(feed.subscribe, feed.snapshot),
  };
}

// why: the drawers of one tab share one list of the last hour, kept a minute after the last of
// them closes.
export function useRecentEvents(): ResourceState<readonly ConsoleEvent[]> {
  const recent = useRecentFeed();
  useEffect(() => recent.acquire(), [recent]);
  return useSyncExternalStore(recent.subscribe, recent.snapshot);
}

const NO_WORKERS: readonly WorkerView[] = [];
const NO_LEASES: readonly LeaseRecord[] = [];
const NO_REQUESTS: readonly WaitingRequest[] = [];
const MINUTE = 60_000;

export interface EventsPage {
  readonly filter: ActivityFilter;
  readonly range: ConsoleRange;
  readonly query: string;
  // why: an empty list says whether nothing happened or the filter hides it.
  readonly held: number;
  readonly rows: readonly ActivityRow[];
  readonly facets: Facets;
  readonly chart: EventsChart;
  readonly chosen: Chosen;
  // why: the row the chosen event sits at, so the box opens with it in view.
  readonly chosenIndex: number;
  readonly loadOlder: () => void;
  // why: the last row says why the list stops; none while more may still load.
  readonly end: HistoryEnd | undefined;
  // why: said while history has not yet reached the start of the range and may still load.
  readonly coverage: string | undefined;
  // why: the id in the URL stands before the list has loaded, so the drawer can open at once.
  readonly urlId: string | undefined;
}

export function useEvents(): LoadView<EventsPage> {
  const { feed: source, history, state: feed } = useEventFeed();
  const events = feed.data;
  // why: the places an event links to are read for the links only; a route that is slow, refused
  // or not served here costs the feed nothing, only the link.
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? NO_WORKERS;
  const leases = useRouteQuery<LeaseList>("/v1/leases").data?.leases ?? NO_LEASES;
  const requests = useRouteQuery<WaitingList>("/v1/lease-requests").data?.requests ?? NO_REQUESTS;
  const now = useNow().server;
  const address = useSearch();
  const filter = useMemo(() => readFilter(address), [address]);
  const defaultRange = useSettings().range;
  const range = readRange(address, defaultRange);
  const query = readQuery(address);
  const id = itemIdFrom("/activity", usePath());
  // why: the view moves once a minute, not with the clock's every tick.
  const minute = Math.floor(now / MINUTE) * MINUTE;
  const view = useMemo(
    () =>
      activityView({
        defaultRange,
        events: events ?? [],
        filter,
        now: minute,
        range,
        search: query,
        workers,
      }),
    [defaultRange, events, filter, minute, query, range, workers],
  );
  return mapView(loadView(feed), (held) => {
    const chosen = chosenEvent(held, id, { leases, requests, workers }, now);
    const chosenId = chosen.kind === "event" ? chosen.detail.id : undefined;
    const end = historyEnd(history, held);
    return {
      chart: view.chart,
      chosen,
      chosenIndex: Math.max(
        0,
        view.rows.findIndex((row) => row.id === chosenId),
      ),
      coverage: view.partial && end === undefined ? coverageText(range) : undefined,
      end,
      facets: view.facets,
      filter,
      held: held.length,
      loadOlder: source.loadOlder,
      query,
      range,
      rows: view.rows,
      urlId: id,
    };
  });
}

function setFilter(filter: ActivityFilter): void {
  setSearch(writeFilter(window.location.search, filter), { replace: true });
}

export function chooseKind(filter: ActivityFilter, kind: Kind): void {
  setFilter(toggleKind(filter, kind));
}

export function chooseWorker(filter: ActivityFilter, worker: string): void {
  setFilter(toggleWorker(filter, worker));
}

export function chooseProblems(filter: ActivityFilter): void {
  setFilter(toggleProblems(filter));
}

// why: each key replaces the entry rather than adding one, so Back leaves the page, not a letter
// of the search.
export function setQuery(query: string): void {
  setSearch(writeQuery(window.location.search, query), { replace: true });
}

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { EventFeed } from "../data/event-feed";
import { browserClock } from "../data/live/browser";
import type { ResourceState } from "../data/live/connection";
import type { LoadView } from "../ds/loaded";
import {
  type Chosen,
  chosenEvent,
  type EventDetail,
  type EventRow,
  eventRows,
  type EventsChart,
  eventsChart,
  readSubject,
  SUBJECT_CHOICES,
  type SubjectFilter,
  writeSubject,
} from "../model/event-list";
import { type ConsoleEvent, type HistoryEnd, type HistoryState, historyEnd } from "../model/events";
import { readQuery, writeQuery } from "../model/paging";
import type { LeaseList, LeaseRecord } from "../model/leases";
import { itemIdFrom } from "../model/paths";
import type { WaitingList, WaitingRequest } from "../model/waiting";
import type { WorkerList, WorkerView } from "../model/workers";
import { useLiveEvents, useRouteQuery, useNow, useStreamOpened } from "./live";
import { loadView, mapView } from "./resource";
import { setSearch, usePath, useSearch } from "./router";
import { useApi } from "./services";

export type { Chosen, EventDetail, EventRow, EventsChart, HistoryEnd, SubjectFilter };
export { SUBJECT_CHOICES };

// why: each screen that reads events holds its own feed, filled from the last hour and then the
// stream while it is on screen, so a screen opened later still starts from a full hour.
function useEventFeed(showsHistory: boolean): {
  readonly feed: EventFeed;
  readonly state: ResourceState<readonly ConsoleEvent[]>;
  readonly history: HistoryState;
} {
  const api = useApi();
  const [feed] = useState(
    () => new EventFeed((path) => api.getJson(path), browserClock, showsHistory),
  );
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  return {
    feed,
    history: useSyncExternalStore(feed.subscribe, feed.history),
    state: useSyncExternalStore(feed.subscribe, feed.snapshot),
  };
}

export function useRecentEvents(): ResourceState<readonly ConsoleEvent[]> {
  return useEventFeed(false).state;
}

const NO_WORKERS: readonly WorkerView[] = [];
const NO_LEASES: readonly LeaseRecord[] = [];
const NO_REQUESTS: readonly WaitingRequest[] = [];
const MINUTE = 60_000;

export interface EventsPage {
  readonly subject: SubjectFilter;
  readonly query: string;
  // why: an empty list says whether nothing happened or the filter hides it.
  readonly held: number;
  readonly rows: readonly EventRow[];
  readonly chart: EventsChart;
  readonly chosen: Chosen;
  // why: the row the chosen event sits at, so the box opens with it in view.
  readonly chosenIndex: number;
  readonly loadOlder: () => void;
  // why: the last row says why the list stops; none while more may still load.
  readonly end: HistoryEnd | undefined;
  // why: the id in the URL stands before the list has loaded, so the drawer can open at once.
  readonly urlId: string | undefined;
}

export function useEvents(): LoadView<EventsPage> {
  const { feed: source, history, state: feed } = useEventFeed(true);
  const events = feed.data;
  // why: the places an event links to are read for the links only; a route that is slow, refused
  // or not served here costs the feed nothing, only the link.
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? NO_WORKERS;
  const leases = useRouteQuery<LeaseList>("/v1/leases").data?.leases ?? NO_LEASES;
  const requests = useRouteQuery<WaitingList>("/v1/lease-requests").data?.requests ?? NO_REQUESTS;
  const now = useNow().server;
  const address = useSearch();
  const subject = readSubject(address);
  const query = readQuery(address);
  const id = itemIdFrom("/activity", usePath());
  const rows = useMemo(
    () => (events === undefined ? [] : eventRows(events, workers, subject, query)),
    [events, workers, subject, query],
  );
  // why: the chart moves once a minute, not with the clock's every tick.
  const minute = Math.floor(now / MINUTE) * MINUTE;
  const chart = useMemo(() => eventsChart(events ?? [], minute), [events, minute]);
  return mapView(loadView(feed), (held) => {
    const chosen = chosenEvent(held, id, { leases, requests, workers }, now);
    const chosenId = chosen.kind === "event" ? chosen.detail.id : undefined;
    return {
      chart,
      chosen,
      end: historyEnd(history, held),
      held: held.length,
      loadOlder: source.loadOlder,
      chosenIndex: Math.max(
        0,
        rows.findIndex((row) => row.id === chosenId),
      ),
      query,
      rows,
      subject,
      urlId: id,
    };
  });
}

export function setSubject(subject: SubjectFilter): void {
  setSearch(writeSubject(window.location.search, subject), { replace: true });
}

// why: each key replaces the entry rather than adding one, so Back leaves the page, not a letter
// of the search.
export function setQuery(query: string): void {
  setSearch(writeQuery(window.location.search, query), { replace: true });
}

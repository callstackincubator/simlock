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
import type { ConsoleEvent } from "../model/events";
import type { LeaseList, LeaseRecord } from "../model/leases";
import { itemIdFrom } from "../model/paths";
import type { WaitingList, WaitingRequest } from "../model/waiting";
import type { WorkerList, WorkerView } from "../model/workers";
import { useLiveEvents, useLiveResource, useNow, useStreamOpened } from "./live";
import { loadView, mapView } from "./resource";
import { setSearch, usePath, useSearch } from "./router";
import { useApi } from "./services";

export type { Chosen, EventDetail, EventRow, EventsChart, SubjectFilter };
export { SUBJECT_CHOICES };

// why: each screen that reads events holds its own feed, filled from the last hour and then the
// stream while it is on screen, so a screen opened later still starts from a full hour.
export function useRecentEvents(): ResourceState<readonly ConsoleEvent[]> {
  const api = useApi();
  const [feed] = useState(() => new EventFeed((path) => api.getJson(path), browserClock));
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  return useSyncExternalStore(feed.subscribe, feed.snapshot);
}

const NO_WORKERS: readonly WorkerView[] = [];
const NO_LEASES: readonly LeaseRecord[] = [];
const NO_REQUESTS: readonly WaitingRequest[] = [];
const MINUTE = 60_000;

export interface EventsPage {
  readonly subject: SubjectFilter;
  // why: an empty list says whether nothing happened or the filter hides it.
  readonly held: number;
  readonly rows: readonly EventRow[];
  readonly chart: EventsChart;
  readonly chosen: Chosen;
  // why: only a URL that names an event shows the inspector first on a phone.
  readonly named: boolean;
  // why: the row the chosen event sits at, so the box opens with it in view.
  readonly chosenIndex: number;
}

export function useEvents(): LoadView<EventsPage> {
  const feed = useRecentEvents();
  const events = feed.data;
  // why: the places an event links to are read for the links only; a route that is slow, refused
  // or not served here costs the feed nothing, only the link.
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers ?? NO_WORKERS;
  const leases = useLiveResource<LeaseList>("/v1/leases").data?.leases ?? NO_LEASES;
  const requests = useLiveResource<WaitingList>("/v1/lease-requests").data?.requests ?? NO_REQUESTS;
  const now = useNow().server;
  const subject = readSubject(useSearch());
  const id = itemIdFrom("/events", usePath());
  const rows = useMemo(
    () => (events === undefined ? [] : eventRows(events, workers, subject)),
    [events, workers, subject],
  );
  // why: the chart moves once a minute, not with the clock's every tick.
  const minute = Math.floor(now / MINUTE) * MINUTE;
  const chart = useMemo(() => eventsChart(events ?? [], minute), [events, minute]);
  return mapView(loadView(feed), (held) => {
    const chosen = chosenEvent(held, rows, id, { leases, requests, workers }, now);
    const chosenId = chosen.kind === "event" ? chosen.detail.id : undefined;
    return {
      chart,
      chosen,
      held: held.length,
      chosenIndex: Math.max(
        0,
        rows.findIndex((row) => row.id === chosenId),
      ),
      named: id !== undefined,
      rows,
      subject,
    };
  });
}

export function setSubject(subject: SubjectFilter): void {
  setSearch(writeSubject(window.location.search, subject), { replace: true });
}

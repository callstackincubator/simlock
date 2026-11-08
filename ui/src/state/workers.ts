import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { EventFeed } from "../data/event-feed";
import { browserClock } from "../data/live/browser";
import type { MenuEntry } from "../ds";
import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import type { LeaseDetails, LeaseList, TokenList } from "../model/leases";
import { workerActions } from "../model/actions";
import { listSearch, readQuery, TABLE_SIZES, writeQuery } from "../model/paging";
import { type FleetAddress, fleetAddress } from "../model/paths";
import {
  filterWorkers,
  fleetRow,
  type FleetRow,
  readDrawerTab,
  readFilter,
  searchWorkers,
  type WorkerFilter,
  writeDrawerTab,
  writeFilter,
  type DeviceDrawerTab,
  type DeviceRow,
  type WorkerPage,
  type WorkerRow,
  type WorkerTab,
  workerPageOf,
  writeWorkerTab,
} from "../model/worker-page";
import { type StreamOffer, streamOffer } from "../model/screen";
import { type WorkerList, workerPath } from "../model/workers";
import { type LogEventRow, logRows } from "../model/event-list";
import { eventsOfWorker, type HistoryEnd, historyEnd } from "../model/events";
import { useActions } from "./actions";
import { useDaemonMode, useLiveEvents, useRouteQuery, useNow, useStreamOpened } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { streamPath } from "./navigation";
import { navigate, setSearch, usePath, useSearch } from "./router";
import { useApi } from "./services";

export type { LogEventRow } from "../model/event-list";
export type {
  FleetRow,
  DeviceDrawerTab,
  DeviceRow,
  InstallRow,
  WarmRow,
  WorkerFilter,
  WorkerPage,
  WorkerRow,
  WorkerTab,
} from "../model/worker-page";
// why: a screen's test builds the view model the same way the hook does, and a screen may import
// no model, so the builders pass through here.
export { fleetRow, WORKER_FILTERS, workerPageOf } from "../model/worker-page";
export type { WorkerView } from "../model/workers";

// why: the row's ⋯ menu reads the one list of actions a worker offers (ADR 0037 §3); on a single host
// or before the mode is known it is empty.
export function useWorkerMenu(): (row: WorkerRow) => readonly MenuEntry[] {
  const { entries } = useActions();
  const mode = useDaemonMode();
  return (row) => entries(workerActions({ ...row, drained: !row.takesLeases }, mode));
}

// why: the worker page's header reads the same list of actions as the Fleet row (ADR 0037 §3).
export function useWorkerPageMenu(page: WorkerPage): readonly MenuEntry[] {
  const { entries } = useActions();
  const mode = useDaemonMode();
  return entries(
    workerActions(
      {
        connection: page.connection,
        drained: page.drained,
        id: page.id,
        name: page.title,
        updateFacts: page.updateFacts,
      },
      mode,
    ),
  );
}

export interface WorkerPageView extends WorkerPage {
  readonly back: string;
  readonly chooseTab: (tab: WorkerTab) => void;
  readonly warmPaging: Paging;
  // why: the tile's Watch link and the page's own address are built from the route's paths.
  readonly streamTo: (deviceId: string) => string;
}

export interface FleetPage {
  readonly empty: boolean;
  readonly filter: WorkerFilter;
  readonly setFilter: (filter: WorkerFilter) => void;
  readonly query: string;
  readonly search: (query: string) => void;
  // why: a worker with anything wrong shows as a card of its own, the rest as compact tiles.
  readonly attention: readonly FleetRow[];
  readonly healthy: readonly FleetRow[];
}

// why: the address names the worker whose page is open, and the device whose drawer is open on it;
// with no worker the fleet's table shows.
export function useFleetAddress(): FleetAddress {
  return fleetAddress(usePath());
}

export function useFleet(): LoadView<FleetPage> {
  const workers = loadView(useRouteQuery<WorkerList>("/v1/workers"));
  const search = useSearch();
  const filter = readFilter(search);
  const ready = workers.kind === "ready";
  const query = readQuery(search);
  const now = useNow();
  const shown = searchWorkers(filterWorkers(ready ? workers.data.workers : [], filter), query);
  const keep = listSearch(search);

  return mapView(workers, (list) => {
    const rows = shown.map((worker) => fleetRow(worker, keep, now.server));
    return {
      attention: rows.filter((row) => row.health.tone !== "ok"),
      empty: list.workers.length === 0,
      filter,
      healthy: rows.filter((row) => row.health.tone === "ok"),
      query,
      // why: each key replaces the entry rather than adding one, so Back leaves the page, not a
      // letter of the search.
      search: (next) => setSearch(writeQuery(window.location.search, next), { replace: true }),
      setFilter: (next) => setSearch(writeFilter(window.location.search, next), { replace: true }),
    };
  });
}

// why: the holders' labels come from the token records and their lease links from the lease list;
// while either has not arrived or was refused, a holder shows its id and the devices still show.
// `undefined` is a worker the fleet does not list.
export function useWorkerPage(id: string): LoadView<WorkerPageView | undefined> {
  const workers = loadView(useRouteQuery<WorkerList>("/v1/workers"));
  const tokens = useRouteQuery<TokenList>("/v1/tokens").data?.tokens ?? [];
  const leases = useRouteQuery<LeaseList>("/v1/leases").data?.leases ?? [];
  const now = useNow();
  const search = useSearch();
  const chosen =
    workers.kind === "ready" ? workers.data.workers.find((worker) => worker.id === id) : undefined;
  const warmPaging = usePaging({
    name: "warm-pool",
    sizes: TABLE_SIZES,
    total: chosen === undefined ? undefined : (chosen.warmPool?.targets.length ?? 0),
  });
  return mapView(workers, () => {
    if (chosen === undefined) return undefined;
    const leaseIds = leases.map((lease) => lease.id);
    return {
      ...workerPageOf({ leaseIds, now: now.server, search, tokens, worker: chosen }),
      back: `/fleet${listSearch(search)}`,
      // why: each choice replaces the entry rather than adding one, so Back leaves the page, not
      // the last tab.
      chooseTab: (tab) => setSearch(writeWorkerTab(window.location.search, tab), { replace: true }),
      streamTo: (deviceId) => streamPath(id, deviceId),
      warmPaging,
    };
  });
}

// why: a device is gone once the worker no longer lists it, and the drawer says so; `undefined` is
// that answer.
export function useDeviceDrawer(
  workerId: string,
  deviceId: string,
): {
  readonly view: LoadView<DeviceRow | undefined>;
  readonly close: () => void;
  readonly tab: DeviceDrawerTab;
  readonly chooseTab: (tab: DeviceDrawerTab) => void;
  readonly stream: StreamOffer;
} {
  const page = useWorkerPage(workerId);
  const search = useSearch();
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers;
  return {
    // why: each choice replaces the entry rather than adding one, as the worker page's tabs do.
    chooseTab: (tab) => setSearch(writeDrawerTab(search, tab), { replace: true }),
    // why: closing replaces the drawer's entry with the worker's own page, tab and paging kept; the
    // drawer's own tab belongs to one open drawer, so it goes.
    close: () =>
      navigate(`${workerPath(workerId)}${writeDrawerTab(search, "details")}`, { replace: true }),
    stream: streamOffer(workers?.find((worker) => worker.id === workerId)),
    tab: readDrawerTab(search),
    view: mapView(page, (shown) => shown?.overview.devices?.find((row) => row.id === deviceId)),
  };
}

// why: a leased device's UDID is known to the console only through its lease.
export function useLeaseUdid(leaseId: string): string | undefined {
  return useRouteQuery<{ readonly lease: LeaseDetails }>(
    `/v1/leases/${encodeURIComponent(leaseId)}`,
  ).data?.lease.udid;
}

export interface WorkerEventsPage {
  readonly rows: readonly LogEventRow[];
  readonly loadOlder: () => void;
  // why: the last row says why the list stops; none while more may still load.
  readonly end: HistoryEnd | undefined;
}

// why: the tab holds its own feed of this worker's events, read from the daemon for that worker
// alone and scrolled back through its history; the stream adds the worker's new ones.
export function useWorkerEvents(workerId: string): LoadView<WorkerEventsPage> {
  const api = useApi();
  // why: the feed outlives the render that built it, and the mode may arrive after the tab mounts,
  // so the filter reads the mode as it is when each event comes.
  const daemonMode = useDaemonMode();
  const mode = useRef(daemonMode);
  mode.current = daemonMode;
  const [feed] = useState(
    () =>
      new EventFeed((path) => api.getJson(path), browserClock, true, {
        keeps: (event) => eventsOfWorker([event], workerId, mode.current).length > 0,
        workerId,
      }),
  );
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  const state = useSyncExternalStore(feed.subscribe, feed.snapshot);
  const history = useSyncExternalStore(feed.subscribe, feed.history);
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  return mapView(loadView(state), (held) => ({
    end: historyEnd(history, held, "No events for this worker yet."),
    loadOlder: feed.loadOlder,
    rows: logRows(held, workers, "all"),
  }));
}

// why: the Fleet page's log holds the workers' own events, from the last hour and then the stream
// while the page is on screen; unlike a worker's feed it asks the daemon for no worker in particular and
// no older history.
export function useFleetEvents(): LoadView<{ readonly rows: readonly LogEventRow[] }> {
  const api = useApi();
  const [feed] = useState(() => new EventFeed((path) => api.getJson(path), browserClock));
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  const state = useSyncExternalStore(feed.subscribe, feed.snapshot);
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  return mapView(loadView(state), (held) => ({ rows: logRows(held, workers, "worker") }));
}

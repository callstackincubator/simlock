import { useRef, useState } from "react";

import { ApiError } from "../data/api";
import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import { type EventRow, eventRows } from "../model/event-list";
import {
  eventsOfLease,
  filterLeaseRows,
  type LeaseDetails,
  type LeaseFilter,
  type LeaseInspection,
  type LeaseList,
  type LeaseRowView,
  leaseInspection,
  leaseRows,
  searchLeaseRows,
  type TokenList,
} from "../model/leases";
import { listSearch, readQuery, TABLE_SIZES, writeQuery } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import type { WorkerList } from "../model/workers";
import { useRecentEvents } from "./events";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { navigate, setSearch, usePath, useSearch } from "./router";

export { type EventRow } from "../model/event-list";
export {
  LEASE_FILTERS,
  type LeaseFilter,
  type LeaseInspection,
  type LeaseRowView,
} from "../model/leases";

export interface LeasesPage {
  readonly rows: readonly LeaseRowView[];
  readonly held: number;
}

export interface Leases {
  readonly view: LoadView<LeasesPage>;
  readonly filter: LeaseFilter;
  readonly choose: (filter: LeaseFilter) => void;
  readonly query: string;
  readonly search: (query: string) => void;
  readonly paging: Paging;
  // why: the id in the URL stands even before the list has loaded, so the drawer can ask for it.
  readonly urlId: string | undefined;
}

export interface LeaseDrawerState {
  readonly fromList: boolean;
  readonly close: () => void;
}

// why: the screen stays mounted from the list to a lease, so a lease that appears while it is
// mounted was opened from the list in this tab, and one present at the first render was loaded
// directly. Closing the first is a step back, so Back does not reopen it; the second has no list
// entry behind it, so closing replaces its address.
export function useLeaseDrawer(urlId: string | undefined): LeaseDrawerState {
  const mountedOpen = useRef(urlId !== undefined);
  if (urlId === undefined) mountedOpen.current = false;
  const fromList = !mountedOpen.current;
  const address = useSearch();
  return {
    close: () => {
      if (fromList) window.history.back();
      else navigate(`/leases${address}`, { replace: true });
    },
    fromList,
  };
}

// why: tokens and workers only name what the leases already show, so while they have not arrived
// or were refused a holder shows its id alone and the leases still show.
export function useLeases(): Leases {
  const urlId = itemIdFrom("/leases", usePath());
  const leases = loadView(useLiveResource<LeaseList>("/v1/leases"));
  const tokens = useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers ?? [];
  const now = useNow();
  const [filter, setFilter] = useState<LeaseFilter>("all");
  const all = mapView(leases, (list) =>
    leaseRows({ leases: list.leases, now: now.server, tokens, workers }),
  );
  const query = readQuery(useSearch());
  const shown =
    all.kind === "ready" ? searchLeaseRows(filterLeaseRows(all.data, filter), query) : [];
  const paging = usePaging({
    sizes: TABLE_SIZES,
    total: all.kind === "ready" ? shown.length : undefined,
  });
  const keep = listSearch(useSearch());
  const view = mapView(all, (every) => ({
    held: every.length,
    rows: shown.map((row) => ({ ...row, to: row.to + keep })),
  }));
  return {
    choose: (next) => {
      setFilter(next);
      if (paging.page !== 1) paging.go(1);
    },
    filter,
    paging,
    query,
    // why: each key replaces the entry rather than adding one, so Back leaves the page, not a
    // letter of the search.
    search: (next) => setSearch(writeQuery(window.location.search, next), { replace: true }),
    urlId,
    view,
  };
}

function isUnknownLease(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === "UNKNOWN_LEASE";
}

// why: a lease that was released or has expired is gone, and the page says so instead of keeping
// the details it last held; `undefined` is that answer.
export function useLeaseInspection(id: string): LoadView<LeaseInspection | undefined> {
  const details = useLiveResource<{ readonly lease: LeaseDetails }>(
    `/v1/leases/${encodeURIComponent(id)}`,
  );
  const list = useLiveResource<LeaseList>("/v1/leases").data?.leases ?? [];
  const tokens = useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers ?? [];
  const now = useNow();
  if (isUnknownLease(details.error)) return { data: undefined, kind: "ready" };
  return mapView(loadView(details), ({ lease }) =>
    leaseInspection({
      lease,
      now: now.server,
      record: list.find((candidate) => candidate.id === lease.id),
      tokens,
      workers,
    }),
  );
}

// why: the events the console holds, an hour of them, that name this lease, newest first.
export function useLeaseEvents(id: string): LoadView<readonly EventRow[]> {
  const feed = useRecentEvents();
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers ?? [];
  return mapView(loadView(feed), (held) => eventRows(eventsOfLease(held, id), workers, "all"));
}

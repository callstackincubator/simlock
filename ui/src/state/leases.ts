import { useState } from "react";

import { ApiError } from "../data/api";
import type { LoadView } from "../ds/loaded";
import type { MenuEntry } from "../ds";
import type { Paging } from "../ds/pager";
import { leaseActions } from "../model/actions";
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
import { useActions } from "./actions";
import { useRecentEvents } from "./events";
import { useListDrawer, type ListDrawerState } from "./drawer";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { setSearch, usePath, useSearch } from "./router";

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

// why: the row's ⋯ menu reads the one list of actions a lease offers (ADR 0037 §3).
export function useLeaseMenu(): (row: LeaseRowView) => readonly MenuEntry[] {
  const { entries } = useActions();
  return (row) => entries(leaseActions(row));
}

// why: a lease's drawer offers the actions of the same row the list shows, under the same item key,
// so an action in flight from either disables both.
export function useLeaseDrawerMenu(id: string): {
  readonly label: string;
  readonly entries: readonly MenuEntry[];
} {
  const { entries } = useActions();
  const leases = useLiveResource<LeaseList>("/v1/leases").data?.leases ?? [];
  const tokens = useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers ?? [];
  const now = useNow();
  const row = leaseRows({ leases, now: now.server, tokens, workers }).find(
    (candidate) => candidate.id === id,
  );
  return row === undefined
    ? { entries: [], label: "" }
    : { entries: entries(leaseActions(row)), label: `Actions for ${row.holder}` };
}

export function useLeaseDrawer(urlId: string | undefined): ListDrawerState {
  return useListDrawer("/leases", urlId);
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

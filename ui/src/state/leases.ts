import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

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
  leaseSummary,
  type LeaseSummary,
  searchLeaseRows,
  type TokenList,
} from "../model/leases";
import { listSearch, readQuery, TABLE_SIZES, writeQuery } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import type { WorkerList } from "../model/workers";
import { useActions } from "./actions";
import { useNotify } from "./services";
import { useRecentEvents } from "./events";
import { useListDrawer, type ListDrawerState } from "./drawer";
import { useRouteQuery, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { setSearch, usePath, useSearch } from "./router";

export { type EventRow } from "../model/event-list";
export {
  LEASE_FILTERS,
  leaseRows,
  type HolderShare,
  type LeaseFilter,
  type LeaseSummary,
  type PlatformShare,
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
  // why: the table's key for the open lease, so its row reads as selected once the list has it.
  readonly selectedKey: string | undefined;
  // why: counted over every lease, not the rows the filter and the search leave.
  readonly summary: LeaseSummary | undefined;
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
  const leases = useRouteQuery<LeaseList>("/v1/leases").data?.leases ?? [];
  const tokens = useRouteQuery<TokenList>("/v1/tokens").data?.tokens ?? [];
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
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
  const leases = loadView(useRouteQuery<LeaseList>("/v1/leases"));
  const tokens = useRouteQuery<TokenList>("/v1/tokens").data?.tokens ?? [];
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
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
  const everyRow = all.kind === "ready" ? all.data : undefined;
  return {
    selectedKey: everyRow?.find((row) => row.id === urlId)?.key,
    summary: everyRow === undefined ? undefined : leaseSummary(everyRow, workers),
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
  const details = useRouteQuery<{ readonly lease: LeaseDetails }>(
    `/v1/leases/${encodeURIComponent(id)}`,
  );
  const list = useRouteQuery<LeaseList>("/v1/leases").data?.leases ?? [];
  const tokens = useRouteQuery<TokenList>("/v1/tokens").data?.tokens ?? [];
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
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
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  return mapView(loadView(feed), (held) => eventRows(eventsOfLease(held, id), workers, "all"));
}

const WIDE_FROM = "(min-width: 1280px)";

function subscribeWide(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(WIDE_FROM);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function isWide(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_FROM).matches;
}

// why: from 1280px the inspector is the page's own right pane; below it a lease opens as a drawer.
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribeWide, isWide, () => true);
}

export const COPY_DEADLINE_MS = 5_000;
export const COPY_FAILURE = "Couldn't copy. Select and copy the id.";

// why: the Clipboard API alone: it may be absent, refuse, or never answer, and then the id stays on
// screen to select. The first of its answer and the deadline wins; whatever comes later, or after the
// page is left, is dropped, so a late success never reads as one.
export function useCopyLeaseId(): (id: string) => void {
  const notify = useNotify();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return useCallback(
    (id: string) => {
      let settled = false;
      const settle = (copied: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!live.current) return;
        notify(copied ? { title: "Copied lease id" } : { title: COPY_FAILURE, tone: "error" });
      };
      const timer = window.setTimeout(() => settle(false), COPY_DEADLINE_MS);
      const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
      if (clipboard === undefined) {
        settle(false);
        return;
      }
      try {
        clipboard.writeText(id).then(
          () => settle(true),
          () => settle(false),
        );
      } catch {
        settle(false);
      }
    },
    [notify],
  );
}

export interface LeaseInspector {
  readonly view: LoadView<LeaseInspection | undefined>;
  readonly release: MenuEntry | undefined;
}

export function useLeaseInspector(id: string): LeaseInspector {
  return {
    release: useLeaseDrawerMenu(id).entries.find((entry) => entry.key === "release-lease"),
    view: useLeaseInspection(id),
  };
}

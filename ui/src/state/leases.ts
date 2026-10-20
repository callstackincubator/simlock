import { useState } from "react";

import { ApiError } from "../data/api";
import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import {
  filterLeaseRows,
  type LeaseDetails,
  type LeaseFilter,
  type LeaseInspection,
  type LeaseList,
  type LeaseRowView,
  leaseInspection,
  leaseRows,
  type TokenList,
} from "../model/leases";
import { listSearch, TABLE_SIZES } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import type { WorkerList } from "../model/workers";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { usePath, useSearch } from "./router";

export {
  LEASE_FILTERS,
  type LeaseFilter,
  type LeaseInspection,
  type LeaseRowView,
} from "../model/leases";

export interface LeasesPage {
  readonly rows: readonly LeaseRowView[];
  readonly held: number;
  // why: the id the inspector shows: the one the URL names, or on a wide screen with none, the
  // first row of the list, without rewriting the URL.
  readonly chosen: string | undefined;
}

export interface Leases {
  readonly view: LoadView<LeasesPage>;
  readonly filter: LeaseFilter;
  readonly choose: (filter: LeaseFilter) => void;
  readonly paging: Paging;
  // why: the id in the URL stands even before the list has loaded, so the inspector can ask for it.
  readonly urlId: string | undefined;
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
  const shown = all.kind === "ready" ? filterLeaseRows(all.data, filter) : [];
  const paging = usePaging({
    sizes: TABLE_SIZES,
    total: all.kind === "ready" ? shown.length : undefined,
  });
  const start = (paging.page - 1) * paging.size;
  const keep = listSearch(useSearch());
  const rows = shown
    .slice(start, start + paging.size)
    .map((row) => ({ ...row, to: row.to + keep }));
  const view = mapView(all, (every) => ({
    chosen: urlId ?? rows[0]?.id,
    held: every.length,
    rows,
  }));
  return {
    choose: (next) => {
      setFilter(next);
      if (paging.page !== 1) paging.go(1);
    },
    filter,
    paging,
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

import { useState } from "react";

import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import type { LeaseList, TokenList } from "../model/leases";
import { listSearch, readQuery, TABLE_SIZES, writeQuery } from "../model/paging";
import { fleetAddress } from "../model/paths";
import {
  filterWorkers,
  searchWorkers,
  upMeta,
  type WorkerFilter,
  type WorkerPage,
  type WorkerRow,
  type WorkerTab,
  workerPageOf,
  workerRow,
  writeWorkerTab,
} from "../model/worker-page";
import type { WorkerList } from "../model/workers";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { setSearch, usePath, useSearch } from "./router";

export type {
  CapabilityRow,
  DeviceRow,
  FigureCard,
  InstallRow,
  PlatformCard,
  WarmRow,
  WorkerFilter,
  WorkerPage,
  WorkerRow,
  WorkerTab,
} from "../model/worker-page";
// why: a screen's test builds the view model the same way the hook does, and a screen may import
// no model, so the builders pass through here.
export { WORKER_FILTERS, workerPageOf, workerRow } from "../model/worker-page";
export type { WorkerView } from "../model/workers";

export interface WorkerPageView extends WorkerPage {
  readonly back: string;
  readonly chooseTab: (tab: WorkerTab) => void;
  readonly devicesPaging: Paging;
  readonly warmPaging: Paging;
}

export interface FleetPage {
  readonly meta: string;
  readonly empty: boolean;
  readonly filter: WorkerFilter;
  readonly setFilter: (filter: WorkerFilter) => void;
  readonly query: string;
  readonly search: (query: string) => void;
  readonly rows: readonly WorkerRow[];
  readonly paging: Paging;
}

// why: the address names the worker whose page is open; with none the fleet's table shows.
export function useFleetAddress(): { readonly workerId: string | undefined } {
  return { workerId: fleetAddress(usePath()).workerId };
}

export function useFleet(): LoadView<FleetPage> {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  const search = useSearch();
  const [filter, setFilter] = useState<WorkerFilter>("all");
  const ready = workers.kind === "ready";
  const query = readQuery(search);
  const shown = searchWorkers(filterWorkers(ready ? workers.data.workers : [], filter), query);
  const paging = usePaging({ sizes: TABLE_SIZES, total: ready ? shown.length : undefined });
  const keep = listSearch(search);

  return mapView(workers, (list) => {
    const start = (paging.page - 1) * paging.size;
    return {
      empty: list.workers.length === 0,
      filter,
      meta: upMeta(list.workers),
      paging,
      query,
      rows: shown.slice(start, start + paging.size).map((worker) => workerRow(worker, keep)),
      // why: each key replaces the entry rather than adding one, so Back leaves the page, not a
      // letter of the search.
      search: (next) => setSearch(writeQuery(window.location.search, next), { replace: true }),
      setFilter,
    };
  });
}

// why: the holders' labels come from the token records and their lease links from the lease list;
// while either has not arrived or was refused, a holder shows its id and the devices still show.
// `undefined` is a worker the fleet does not list.
export function useWorkerPage(id: string): LoadView<WorkerPageView | undefined> {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  const tokens = useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
  const leases = useLiveResource<LeaseList>("/v1/leases").data?.leases ?? [];
  const now = useNow();
  const search = useSearch();
  const chosen =
    workers.kind === "ready" ? workers.data.workers.find((worker) => worker.id === id) : undefined;
  const devicesPaging = usePaging({
    name: "devices",
    sizes: TABLE_SIZES,
    total: chosen === undefined ? undefined : (chosen.devices?.length ?? 0),
  });
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
      devicesPaging,
      warmPaging,
    };
  });
}

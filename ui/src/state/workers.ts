import { useState } from "react";

import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import type { LeaseList, TokenList } from "../model/leases";
import { listSearch, TABLE_SIZES } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import {
  filterWorkers,
  upMeta,
  type WorkerFilter,
  type WorkerInspector,
  type WorkerRow,
  workerInspectorOf,
  workerRow,
} from "../model/worker-page";
import type { WorkerList, WorkerView } from "../model/workers";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { usePath, useSearch } from "./router";

export type {
  CapabilityRow,
  DeviceRow,
  FigureCard,
  InstallRow,
  PlatformCard,
  WarmRow,
  WorkerFilter,
  WorkerInspector,
  WorkerRow,
  WorkerTab,
} from "../model/worker-page";
// why: a screen's test builds the view model the same way the hook does, and a screen may import
// no model, so the builders pass through here.
export { WORKER_FILTERS, workerInspectorOf, workerRow } from "../model/worker-page";
export type { WorkerView } from "../model/workers";

export interface WorkerInspectorView extends WorkerInspector {
  readonly devicesPaging: Paging;
  readonly warmPaging: Paging;
}

export interface WorkersPage {
  readonly meta: string;
  readonly empty: boolean;
  readonly filter: WorkerFilter;
  readonly setFilter: (filter: WorkerFilter) => void;
  readonly rows: readonly WorkerRow[];
  readonly paging: Paging;
  readonly chosen: string | undefined;
  // why: the page is `detail` on a phone only when the URL names a worker.
  readonly focus: "list" | "detail";
  readonly inspector: WorkerInspectorView | undefined;
  readonly missing: string | undefined;
}

export function useWorkers(): LoadView<WorkersPage> {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  const search = useSearch();
  const named = itemIdFrom("/fleet", usePath());
  const [filter, setFilter] = useState<WorkerFilter>("all");

  const ready = workers.kind === "ready";
  const all = ready ? workers.data.workers : [];
  const shown = filterWorkers(all, filter);
  const paging = usePaging({ sizes: TABLE_SIZES, total: ready ? shown.length : undefined });
  const chosenId = named ?? shown[0]?.id;
  const chosen = all.find((worker) => worker.id === chosenId);
  const inspector = useInspector(chosen, ready);
  const keep = listSearch(search);

  return mapView(workers, (list) => {
    const start = (paging.page - 1) * paging.size;
    return {
      chosen: chosenId,
      empty: list.workers.length === 0,
      filter,
      focus: named === undefined ? "list" : "detail",
      inspector,
      meta: upMeta(list.workers),
      missing: named !== undefined && chosen === undefined ? named : undefined,
      paging,
      rows: shown.slice(start, start + paging.size).map((worker) => workerRow(worker, keep)),
      setFilter,
    };
  });
}

function inspectorTotals(chosen: WorkerView | undefined): { devices: number; warm: number } {
  return {
    devices: chosen?.devices?.length ?? 0,
    warm: chosen?.warmPool?.targets.length ?? 0,
  };
}

// why: the holders' labels come from the token records and their lease links from the lease list;
// while either has not arrived or was refused, a holder shows its id and the devices still show.
function useInspector(
  chosen: WorkerView | undefined,
  ready: boolean,
): WorkerInspectorView | undefined {
  const tokens = useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
  const leases = useLiveResource<LeaseList>("/v1/leases").data?.leases ?? [];
  const now = useNow();
  const totals = ready ? inspectorTotals(chosen) : undefined;
  const devicesPaging = usePaging({ name: "devices", sizes: TABLE_SIZES, total: totals?.devices });
  const warmPaging = usePaging({ name: "warm-pool", sizes: TABLE_SIZES, total: totals?.warm });
  if (chosen === undefined) return undefined;
  const leaseIds = leases.map((lease) => lease.id);
  return {
    ...workerInspectorOf({ leaseIds, now: now.server, tokens, worker: chosen }),
    devicesPaging,
    warmPaging,
  };
}

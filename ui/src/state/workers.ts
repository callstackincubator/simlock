import { useState } from "react";

import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import type { TokenList } from "../model/leases";
import { TABLE_SIZES } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import {
  filterWorkers,
  listSearch,
  upMeta,
  type WorkerFilter,
  type WorkerInspector,
  type WorkerRow,
  workerInspectorOf,
  workerRow,
} from "../model/worker-page";
import type { WorkerList } from "../model/workers";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { usePath, useSearch } from "./router";

export type {
  CapabilityRow,
  CatalogRow,
  DeviceRow,
  FigureCard,
  InstallRow,
  LoadDetail,
  OverviewTab,
  PlatformCard,
  WarmRow,
  WarmTab,
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
  // why: the holders' labels come from the token records; while they have not arrived or were
  // refused, a holder shows its id alone and the devices still show.
  const tokens = useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
  const now = useNow();
  const search = useSearch();
  const named = itemIdFrom("/workers", usePath());
  const [filter, setFilter] = useState<WorkerFilter>("all");

  const all = workers.kind === "ready" ? workers.data.workers : [];
  const shown = filterWorkers(all, filter);
  const ready = workers.kind === "ready";
  const paging = usePaging({ sizes: TABLE_SIZES, total: ready ? shown.length : undefined });
  const first = shown[0];
  const chosenId = named ?? first?.id;
  const chosen = all.find((worker) => worker.id === chosenId);
  const devicesPaging = usePaging({
    name: "devices",
    sizes: TABLE_SIZES,
    total: ready ? (chosen?.devices?.length ?? 0) : undefined,
  });
  const warmPaging = usePaging({
    name: "warm-pool",
    sizes: TABLE_SIZES,
    total: ready ? (chosen?.warmPool?.targets.length ?? 0) : undefined,
  });
  const keep = listSearch(search);

  return mapView(workers, (list) => {
    const start = (paging.page - 1) * paging.size;
    return {
      chosen: chosenId,
      empty: list.workers.length === 0,
      filter,
      focus: named === undefined ? "list" : "detail",
      inspector:
        chosen === undefined
          ? undefined
          : {
              ...workerInspectorOf({ now: now.server, tokens, worker: chosen }),
              devicesPaging,
              warmPaging,
            },
      meta: upMeta(list.workers),
      missing: named !== undefined && chosen === undefined ? named : undefined,
      paging,
      rows: shown.slice(start, start + paging.size).map((worker) => workerRow(worker, keep)),
      setFilter,
    };
  });
}

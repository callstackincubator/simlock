import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import { type BaselineList, type BaselineRow, baselineRows } from "../model/baselines";
import { TABLE_SIZES } from "../model/paging";
import type { WorkerList } from "../model/workers";
import { useDaemonMode, useNow, useRouteQuery } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";

export type { BaselineRow } from "../model/baselines";

export interface BaselinesPage {
  readonly rows: readonly BaselineRow[];
  readonly paging: Paging;
  readonly gateway: boolean;
}

export function useBaselines(): LoadView<BaselinesPage> {
  const list = loadView(useRouteQuery<BaselineList>("/v1/baselines"));
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  const now = useNow();
  const gateway = useDaemonMode() === "gateway";
  const rows = mapView(list, (all) => baselineRows(all.baselines, workers, now.server));
  const paging = usePaging({
    sizes: TABLE_SIZES,
    total: rows.kind === "ready" ? rows.data.length : undefined,
  });
  return mapView(rows, (all) => ({ gateway, paging, rows: all }));
}

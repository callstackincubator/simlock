import { useState } from "react";

import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import {
  type BaselineFilter,
  type BaselineList,
  type BaselineRow,
  baselineRows,
  filterBaselineRows,
  groupLabels,
  searchBaselineRows,
} from "../model/baselines";
import { readQuery, TABLE_SIZES, writeQuery } from "../model/paging";
import type { WorkerList } from "../model/workers";
import { useDaemonMode, useNow, useRouteQuery } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { setSearch, useSearch } from "./router";

export { BASELINE_FILTERS, type BaselineFilter, type BaselineRow } from "../model/baselines";

export interface BaselinesPage {
  readonly rows: readonly BaselineRow[];
  readonly group: (row: BaselineRow) => { readonly id: string; readonly label: string };
  readonly paging: Paging;
  readonly gateway: boolean;
  readonly narrowed: boolean;
}

export interface Baselines {
  readonly view: LoadView<BaselinesPage>;
  readonly filter: BaselineFilter;
  readonly choose: (filter: BaselineFilter) => void;
  readonly query: string;
  readonly search: (query: string) => void;
}

export function useBaselines(): Baselines {
  const list = loadView(useRouteQuery<BaselineList>("/v1/baselines"));
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  const now = useNow();
  const gateway = useDaemonMode() === "gateway";
  const [filter, setFilter] = useState<BaselineFilter>("all");
  const query = readQuery(useSearch());
  const all = mapView(list, (found) => baselineRows(found.baselines, workers, now.server));
  // why: filter and search come before grouping and paging, so a group's count is its matches.
  const shown =
    all.kind === "ready" ? searchBaselineRows(filterBaselineRows(all.data, filter), query) : [];
  const paging = usePaging({
    sizes: TABLE_SIZES,
    total: all.kind === "ready" ? shown.length : undefined,
  });
  const labels = groupLabels(shown);
  const view = mapView(all, () => ({
    gateway,
    group: (row: BaselineRow) => ({
      id: row.platform,
      label: labels.get(row.platform) ?? row.platformName,
    }),
    narrowed: filter !== "all" || query !== "",
    paging,
    rows: shown,
  }));
  return {
    choose: (next) => {
      setFilter(next);
      if (paging.page !== 1) paging.go(1);
    },
    filter,
    query,
    // why: each key replaces the entry rather than adding one, so Back leaves the page, not a letter.
    search: (next) => setSearch(writeQuery(window.location.search, next), { replace: true }),
    view,
  };
}

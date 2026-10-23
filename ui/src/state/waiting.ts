import type { MenuEntry } from "../ds";
import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import type { FigureTile } from "../model/figures";
import { requestActions } from "../model/actions";
import { listSearch, TABLE_SIZES } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import {
  chooseWaiting,
  type WaitingChoice,
  type WaitingList,
  type WaitingRow,
  waitingTable,
} from "../model/waiting";
import type { WorkerList } from "../model/workers";
import { useActions } from "./actions";
import { useFigures } from "./figures";
import { useRouteQuery, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { usePath, useSearch } from "./router";

export type { WaitingQueue, WaitingRow } from "../model/waiting";

export interface WaitingPage extends WaitingChoice {
  readonly meta: string;
  readonly rows: readonly WaitingRow[];
  readonly paging: Paging;
  // why: the id in the URL stands even before the list has loaded, so the drawer can ask for it.
  readonly urlId: string | undefined;
  readonly wait: LoadView<FigureTile>;
}

// why: the row's ⋯ menu reads the one list of actions a waiting request offers (ADR 0037 §3).
export function useQueueMenu(): (row: WaitingRow) => readonly MenuEntry[] {
  const { entries } = useActions();
  return (row) => entries(requestActions(row));
}

export function useWaiting(): LoadView<WaitingPage> {
  const requests = loadView(useRouteQuery<WaitingList>("/v1/lease-requests"));
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  const figures = useFigures("1h");
  const now = useNow();
  const id = itemIdFrom("/queue", usePath());
  const keep = listSearch(useSearch());
  const table = mapView(requests, (list) => waitingTable(list.requests, workers, now.server));
  const paging = usePaging({
    sizes: TABLE_SIZES,
    total: table.kind === "ready" ? table.data.rows.length : undefined,
  });
  return mapView(table, (all) => ({
    ...chooseWaiting(all.rows, id),
    meta: all.meta,
    paging,
    rows: all.rows.map((row) => ({ ...row, to: row.to + keep })),
    urlId: id,
    wait:
      figures.kind === "ready"
        ? {
            data: figures.data.wait,
            kind: "ready",
            ...(figures.refusal === undefined ? {} : { refusal: figures.refusal }),
          }
        : figures,
  }));
}

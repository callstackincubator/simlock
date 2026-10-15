import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import { TABLE_SIZES } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import {
  chooseWaiting,
  type WaitingChoice,
  type WaitingList,
  type WaitingRow,
  waitingTable,
} from "../model/waiting";
import type { WorkerList } from "../model/workers";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { usePath } from "./router";

export type { WaitingQueue, WaitingRow } from "../model/waiting";

export interface WaitingPage extends WaitingChoice {
  readonly meta: string;
  readonly rows: readonly WaitingRow[];
  readonly count: number;
  readonly paging: Paging;
  readonly named: boolean;
}

export function useWaiting(): LoadView<WaitingPage> {
  const requests = loadView(useLiveResource<WaitingList>("/v1/lease-requests"));
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers ?? [];
  const now = useNow();
  const id = itemIdFrom("/waiting", usePath());
  const table = mapView(requests, (list) => waitingTable(list.requests, workers, now.server));
  const paging = usePaging({
    sizes: TABLE_SIZES,
    total: table.kind === "ready" ? table.data.rows.length : undefined,
  });
  return mapView(table, (all) => {
    const rows = all.rows.slice((paging.page - 1) * paging.size, paging.page * paging.size);
    return {
      ...chooseWaiting(all.rows, id, rows),
      count: all.rows.length,
      meta: all.meta,
      named: id !== undefined,
      paging,
      rows,
    };
  });
}

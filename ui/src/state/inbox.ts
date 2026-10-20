import type { LoadView } from "../ds/loaded";
import type { Paging } from "../ds/pager";
import { type InboxPage, inboxPageOf, type InboxRow } from "../model/inbox";
import { listSearch, TABLE_SIZES } from "../model/paging";
import { itemIdFrom } from "../model/paths";
import type { WorkerList } from "../model/workers";
import { useRecentEvents } from "./events";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { bothViews, loadView, mapView } from "./resource";
import { usePath, useSearch } from "./router";

export type { InboxDetail, InboxEvent, InboxPage, InboxRow } from "../model/inbox";
export type { Paging } from "../ds/pager";

export function useAttention(): LoadView<InboxPage> {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  // why: the events only fill the inspector's list, so a feed still loading shows the page with
  // none rather than holding back the list.
  const feed = useRecentEvents();
  const now = useNow();
  const key = itemIdFrom("/inbox", usePath());
  const reads = bothViews(workers, { data: feed.data ?? [], kind: "ready" });
  return mapView(reads, ([list, events]) =>
    inboxPageOf({ events, key, now: now.server, workers: list.workers }),
  );
}

// why: the pager is read once the list is known, so a page in the URL is never corrected against
// a list that has not arrived.
export function useInboxRows(rows: readonly InboxRow[]): {
  readonly shown: readonly InboxRow[];
  readonly paging: Paging;
} {
  const paging = usePaging({ sizes: TABLE_SIZES, total: rows.length });
  const keep = listSearch(useSearch());
  const start = (paging.page - 1) * paging.size;
  return {
    paging,
    shown: rows.slice(start, start + paging.size).map((row) => ({ ...row, to: row.to + keep })),
  };
}

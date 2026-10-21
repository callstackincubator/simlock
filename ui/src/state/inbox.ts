import { useState } from "react";

import type { LoadView } from "../ds/loaded";
import {
  filterInboxRows,
  type InboxFilter,
  type InboxPage,
  inboxPageOf,
  type InboxRow,
} from "../model/inbox";
import type { LeaseList, TokenList } from "../model/leases";
import { itemIdFrom } from "../model/paths";
import type { WaitingList } from "../model/waiting";
import type { WorkerList } from "../model/workers";
import { type ListDrawerState, useListDrawer } from "./drawer";
import { useRecentEvents } from "./events";
import { useLiveResource, useNow } from "./live";
import { bothViews, loadView, mapView } from "./resource";
import { usePath } from "./router";

export type { InboxEvent, InboxPage, InboxRow } from "../model/inbox";
export { INBOX_FILTERS, type InboxFilter } from "../model/inbox";

export interface InboxReads {
  readonly waiting: LoadView<WaitingList>;
  readonly leases: LeaseList["leases"] | undefined;
  readonly tokens: TokenList["tokens"] | undefined;
  readonly couldNotCheck: readonly string[];
}

// why: a daemon that keeps no queue of its own answers 501; the Inbox then counts no waiting
// requests instead of hiding the fleet behind "not available". A read that failed is not that:
// the rest still shows, and the page says what could not be checked.
export function useInboxReads(): InboxReads {
  const asked = loadView(useLiveResource<WaitingList>("/v1/lease-requests"));
  const leases = useLiveResource<LeaseList>("/v1/leases");
  const tokens = useLiveResource<TokenList>("/v1/tokens");
  const failed = asked.kind === "refused";
  return {
    couldNotCheck: [
      ...(failed ? ["waiting requests"] : []),
      ...(leases.data === undefined && leases.error !== undefined ? ["leases"] : []),
    ],
    leases: leases.data?.leases,
    tokens: tokens.data?.tokens,
    waiting:
      asked.kind === "unsupported" || failed ? { data: { requests: [] }, kind: "ready" } : asked,
  };
}

export interface Inbox {
  readonly view: LoadView<InboxPage>;
  readonly filter: InboxFilter;
  readonly choose: (filter: InboxFilter) => void;
  readonly rows: (page: InboxPage) => readonly InboxRow[];
  // why: the key in the URL stands even before the list has loaded, so the drawer can ask for it.
  readonly urlId: string | undefined;
}

export function useInbox(): Inbox {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  const reads = useInboxReads();
  // why: the events only fill the drawer's list, so a feed still loading shows the page with
  // none rather than holding back the list.
  const feed = useRecentEvents();
  const now = useNow();
  const urlId = itemIdFrom("/inbox", usePath());
  const [filter, choose] = useState<InboxFilter>("all");
  const view = mapView(
    bothViews(bothViews(workers, reads.waiting), { data: feed.data ?? [], kind: "ready" }),
    ([[list, waiting], events]) =>
      inboxPageOf({
        events,
        key: urlId,
        leases: reads.leases,
        now: now.server,
        requests: waiting.requests,
        tokens: reads.tokens,
        workers: list.workers,
      }),
  );
  return {
    choose,
    filter,
    rows: (page) => filterInboxRows(page.rows, filter),
    urlId,
    view,
  };
}

export function useInboxDrawer(urlId: string | undefined): ListDrawerState {
  return useListDrawer("/inbox", urlId);
}

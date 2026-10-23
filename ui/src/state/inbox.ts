import { useState } from "react";

import type { ResourceState } from "../data/live/connection";
import type { MenuEntry } from "../ds";
import type { LoadView } from "../ds/loaded";
import { inboxActions } from "../model/actions";
import {
  filterInboxRows,
  inboxItems,
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
import { useActions } from "./actions";
import { useDaemonMode, useRouteQuery, useNow } from "./live";
import { bothViews, loadView, mapView } from "./resource";
import { usePath } from "./router";

export type { InboxEvent, InboxPage, InboxRow } from "../model/inbox";
export { INBOX_FILTERS, type InboxFilter } from "../model/inbox";

export interface InboxReads {
  readonly waiting: LoadView<WaitingList>;
  readonly workers: LoadView<WorkerList>;
  readonly leases: LeaseList["leases"] | undefined;
  readonly tokens: TokenList["tokens"] | undefined;
  readonly couldNotCheck: readonly string[];
}

// why: a daemon that keeps no queue of its own answers 501; the Inbox then counts no waiting
// requests instead of hiding the fleet behind "not available". A read that failed is not that,
// even when an earlier answer is still held: the rest still shows, and the page says what could
// not be checked. A read that failed after an answer counts nothing from it either: the held
// answer is stale, and a figure from it would read as known.
export function inboxReadsOf(
  asked: ResourceState<WaitingList>,
  leases: ResourceState<LeaseList>,
  tokens: ResourceState<TokenList>,
  workerState: ResourceState<WorkerList>,
): InboxReads {
  const waiting = loadView(asked);
  const workers = loadView(workerState);
  const failed =
    waiting.kind === "refused" || (waiting.kind === "ready" && waiting.refusal !== undefined);
  return {
    couldNotCheck: [
      ...(failed ? ["waiting requests"] : []),
      ...(leases.error === undefined ? [] : ["leases"]),
      ...(workers.kind === "ready" && workers.refusal !== undefined ? ["workers"] : []),
    ],
    leases: leases.error === undefined ? leases.data?.leases : undefined,
    tokens: tokens.data?.tokens,
    waiting:
      waiting.kind === "unsupported" || waiting.kind === "refused"
        ? { data: { requests: [] }, kind: "ready" }
        : waiting,
    workers,
  };
}

export function useInboxReads(): InboxReads {
  return inboxReadsOf(
    useRouteQuery<WaitingList>("/v1/lease-requests"),
    useRouteQuery<LeaseList>("/v1/leases"),
    useRouteQuery<TokenList>("/v1/tokens"),
    useRouteQuery<WorkerList>("/v1/workers"),
  );
}

export interface Inbox {
  readonly view: LoadView<InboxPage>;
  readonly filter: InboxFilter;
  readonly choose: (filter: InboxFilter) => void;
  readonly rows: (page: InboxPage) => readonly InboxRow[];
  readonly couldNotCheck: readonly string[];
  // why: the key in the URL stands even before the list has loaded, so the drawer can ask for it.
  readonly urlId: string | undefined;
}

export function useInbox(): Inbox {
  const reads = useInboxReads();
  // why: the events only fill the drawer's list, so a feed still loading shows the page with
  // none rather than holding back the list.
  const feed = useRecentEvents();
  const now = useNow();
  const urlId = itemIdFrom("/inbox", usePath());
  const [filter, choose] = useState<InboxFilter>("all");
  const view = mapView(
    bothViews(bothViews(reads.workers, reads.waiting), { data: feed.data ?? [], kind: "ready" }),
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
    couldNotCheck: reads.couldNotCheck,
    filter,
    rows: (page) => filterInboxRows(page.rows, filter),
    urlId,
    view,
  };
}

export function useInboxDrawer(urlId: string | undefined): ListDrawerState {
  return useListDrawer("/inbox", urlId);
}

export interface InboxRowActions {
  readonly fix?: MenuEntry;
  readonly menu: readonly MenuEntry[];
}

// why: an Inbox row reads the one list of actions its item offers (ADR 0037 §3); only a drained
// worker's row has a fix button.
export function useInboxActions(): (row: InboxRow) => InboxRowActions {
  const reads = useInboxReads();
  const { entries } = useActions();
  const mode = useDaemonMode();
  const now = useNow();
  const workers = reads.workers.kind === "ready" ? reads.workers.data.workers : [];
  const waiting = reads.waiting.kind === "ready" ? reads.waiting.data.requests : [];
  const tokens = reads.tokens ?? [];
  const items = inboxItems(workers, {
    leases: reads.leases,
    now: now.server,
    requests: waiting,
    tokens,
  });
  return (row) => {
    const item = items.find((candidate) => candidate.key === row.key);
    if (item === undefined) return { menu: [] };
    const actions = inboxActions(item, { mode, now: now.server, tokens, workers });
    const [fix] = actions.fix === undefined ? [] : entries([actions.fix]);
    return { menu: entries(actions.menu), ...(fix === undefined ? {} : { fix }) };
  };
}

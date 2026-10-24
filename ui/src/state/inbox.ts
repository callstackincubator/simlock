import { useState } from "react";

import type { MenuEntry } from "../ds";
import type { LoadView } from "../ds/loaded";
import { inboxActions } from "../model/actions";
import {
  filterInboxRows,
  type InboxFilter,
  type InboxList,
  type InboxPage,
  inboxPageOf,
  type InboxRow,
} from "../model/inbox";
import { itemIdFrom } from "../model/paths";
import type { WorkerList } from "../model/workers";
import { type ListDrawerState, useListDrawer } from "./drawer";
import { useRecentEvents } from "./events";
import { useActions } from "./actions";
import { useDaemonMode, useRouteQuery, useNow } from "./live";
import { bothViews, loadView, mapView } from "./resource";
import { usePath } from "./router";

export type { InboxEvent, InboxPage, InboxRow } from "../model/inbox";
export { INBOX_FILTERS, type InboxFilter } from "../model/inbox";

export interface Inbox {
  readonly view: LoadView<InboxPage>;
  readonly filter: InboxFilter;
  readonly choose: (filter: InboxFilter) => void;
  readonly rows: (page: InboxPage) => readonly InboxRow[];
  // why: the key in the URL stands even before the list has loaded, so the drawer can ask for it.
  readonly urlId: string | undefined;
}

export function useInbox(): Inbox {
  const items = loadView(useRouteQuery<InboxList>("/v1/inbox"));
  const workers = loadView(useRouteQuery<WorkerList>("/v1/workers"));
  // why: the events only fill the drawer's list, so a feed still loading shows the page with
  // none rather than holding back the list.
  const feed = useRecentEvents();
  const now = useNow();
  const urlId = itemIdFrom("/inbox", usePath());
  const [filter, choose] = useState<InboxFilter>("all");
  const view = mapView(
    bothViews(bothViews(items, workers), { data: feed.data ?? [], kind: "ready" }),
    ([[inbox, list], events]) =>
      inboxPageOf({
        events,
        items: inbox.items,
        key: urlId,
        now: now.server,
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

export interface InboxRowActions {
  readonly fix?: MenuEntry;
  readonly menu: readonly MenuEntry[];
}

// why: an Inbox row reads the one list of actions its item offers (ADR 0037 §3); only a drained
// worker's row has a fix button.
export function useInboxActions(): (row: InboxRow) => InboxRowActions {
  const items = useRouteQuery<InboxList>("/v1/inbox").data?.items ?? [];
  const { entries } = useActions();
  const mode = useDaemonMode();
  const workers = useRouteQuery<WorkerList>("/v1/workers").data?.workers ?? [];
  return (row) => {
    const item = items.find((candidate) => candidate.key === row.key);
    if (item === undefined) return { menu: [] };
    const actions = inboxActions(item, { mode, workers });
    const [fix] = actions.fix === undefined ? [] : entries([actions.fix]);
    return { menu: entries(actions.menu), ...(fix === undefined ? {} : { fix }) };
  };
}

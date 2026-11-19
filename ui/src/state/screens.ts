import { useEffect, useState, useSyncExternalStore } from "react";

import { documentVisibility } from "../data/live/browser";
import { TABLE_SIZES } from "../model/paging";
import { SCREEN_CAPTURE_LIMIT } from "../model/screen";
import {
  createCaptureBudget,
  filterScreens,
  readWatch,
  type ScreenFilter,
  screenNotice,
  screensOf,
  type ScreenTile,
  watchedOf,
  writeWatch,
} from "../model/screens";
import type { WorkerList } from "../model/workers";
import { useConnection, useNow, useRouteQuery } from "./live";
import { usePaging } from "./paging";
import { loadView, mapView } from "./resource";
import { setSearch, useSearch } from "./router";

export { SCREEN_FILTERS, type ScreenFilter, type ScreenTile } from "../model/screens";
export type { AcquireCapture } from "./screen";

export const WATCH_LIMIT = SCREEN_CAPTURE_LIMIT;

// why: the sidebar's link to Screens carries no list, so the tab remembers the last one and puts it
// back in the address when the page opens without one.
let remembered: readonly string[] = [];

export function useScreens() {
  const [acquire] = useState(createCaptureBudget);
  const [filter, setFilter] = useState<ScreenFilter>("leased");
  const now = useNow().server;
  const all = mapView(loadView(useRouteQuery<WorkerList>("/v1/workers")), (data) =>
    screensOf(data.workers, now),
  );
  const tiles = all.kind === "ready" ? all.data : [];
  const shown = filterScreens(tiles, filter);
  const paging = usePaging({
    sizes: TABLE_SIZES,
    total: all.kind === "ready" ? shown.length : undefined,
  });
  const search = useSearch();
  const keys = readWatch(search);
  useEffect(() => {
    const opened = readWatch(window.location.search);
    if (opened.length > 0) remembered = opened;
    else if (remembered.length > 0)
      setSearch(writeWatch(window.location.search, remembered), { replace: true });
  }, []);
  // why: a watched device that stopped running leaves the list, so it frees its place at once.
  const watched = all.kind === "ready" ? watchedOf(tiles, keys) : [];
  const watching = new Set(watched.map((tile) => tile.key));
  const write = (next: readonly string[]) => {
    remembered = next;
    setSearch(writeWatch(window.location.search, next), { replace: true });
  };
  const view = mapView(all, () => ({
    paging,
    rows: shown,
    watched,
  }));
  const connection = useConnection();
  return {
    acquire,
    choose: (next: ScreenFilter) => {
      setFilter(next);
      if (paging.page !== 1) paging.go(1);
    },
    connected: connection.phase === "connected",
    filter,
    full: watched.length >= WATCH_LIMIT,
    isWatched: (tile: ScreenTile) => watching.has(tile.key),
    stop: (tile: ScreenTile) => write(watched.map((t) => t.key).filter((key) => key !== tile.key)),
    view,
    watch: (tile: ScreenTile) => {
      if (watched.length < WATCH_LIMIT && !watching.has(tile.key))
        write([...watched.map((t) => t.key), tile.key]);
    },
  };
}

// why: a watched screen pauses while the browser tab is hidden and resumes when it is shown.
export function useScreenTile(tile: ScreenTile, connected: boolean) {
  const hidden = useSyncExternalStore(
    documentVisibility.subscribe,
    documentVisibility.hidden,
    () => true,
  );
  return { notice: screenNotice({ active: !hidden, connected, offer: tile.offer }) };
}

import { useEffect, useState, useSyncExternalStore } from "react";

import { EventFeed } from "../data/event-feed";
import { browserClock } from "../data/live/browser";
import type { ResourceState } from "../data/live/connection";
import type { ConsoleEvent } from "../model/events";
import { useLiveEvents, useStreamOpened } from "./live";
import { useApi } from "./services";

// why: each screen that reads events holds its own feed, filled from the last hour and then the
// stream while it is on screen, so a screen opened later still starts from a full hour.
export function useRecentEvents(): ResourceState<readonly ConsoleEvent[]> {
  const api = useApi();
  const [feed] = useState(() => new EventFeed((path) => api.getJson(path), browserClock));
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  return useSyncExternalStore(feed.subscribe, feed.snapshot);
}

import type { LoadView } from "../ds/loaded";
import { overviewOf, type Overview } from "../model/overview";
import type { ConsoleRange } from "../model/range";
import type { WorkerList } from "../model/workers";
import { useRecentEvents } from "./events";
import { useFigures } from "./figures";
import { useLiveResource, useNow } from "./live";
import { useInboxReads } from "./inbox";
import { bothViews, loadView, mapView } from "./resource";

export type {
  Overview,
  OverviewActivity,
  OverviewInbox,
  OverviewItem,
  OverviewWorker,
  Gauge,
  PlatformCapacity,
} from "../model/overview";

export function useOverview(range: ConsoleRange): LoadView<Overview> {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  const { couldNotCheck, leases, tokens, waiting } = useInboxReads();
  const events = loadView(useRecentEvents());
  const figures = useFigures(range);
  const now = useNow();
  const reads = bothViews(bothViews(workers, waiting), events);
  return mapView(reads, ([[workerList, waitingList], recent]) =>
    overviewOf({
      events: recent,
      couldNotCheck,
      figures,
      leases,
      now: now.server,
      requests: waitingList.requests,
      tokens,
      workers: workerList.workers,
    }),
  );
}

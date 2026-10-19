import type { LoadView } from "../ds/loaded";
import { overviewOf, type Overview } from "../model/overview";
import type { ConsoleRange } from "../model/range";
import type { WaitingList } from "../model/waiting";
import type { WorkerList } from "../model/workers";
import { useRecentEvents } from "./events";
import { useFigures } from "./figures";
import { useLiveResource, useNow } from "./live";
import { bothViews, loadView, mapView } from "./resource";

export type {
  Overview,
  OverviewActivity,
  OverviewItem,
  OverviewWorker,
  Gauge,
  PlatformUse,
} from "../model/overview";

export function useOverview(range: ConsoleRange): LoadView<Overview> {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  const asked = loadView(useLiveResource<WaitingList>("/v1/lease-requests"));
  // why: a daemon that keeps no queue of its own answers 501; the overview then counts no waiting
  // requests instead of hiding the whole fleet behind "not available".
  const waiting: LoadView<WaitingList> =
    asked.kind === "unsupported" ? { data: { requests: [] }, kind: "ready" } : asked;
  const events = loadView(useRecentEvents());
  const figures = useFigures(range);
  const now = useNow();
  const reads = bothViews(bothViews(workers, waiting), events);
  return mapView(reads, ([[workerList, waitingList], recent]) =>
    overviewOf({
      events: recent,
      figures,
      now: now.server,
      requests: waitingList.requests,
      workers: workerList.workers,
    }),
  );
}

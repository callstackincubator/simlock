import type { LoadView } from "../ds/loaded";
import { overviewOf, type Overview } from "../model/overview";
import type { ConsoleRange } from "../model/range";
import type { WorkerList } from "../model/workers";
import { useFigures } from "./figures";
import { useLiveResource, useNow } from "./live";
import { useInboxReads } from "./inbox";
import { bothViews, loadView, mapView } from "./resource";

export type { Overview, OverviewInbox, PlatformCapacity } from "../model/overview";

export function useOverview(range: ConsoleRange): LoadView<Overview> {
  const workers = loadView(useLiveResource<WorkerList>("/v1/workers"));
  const { couldNotCheck, leases, tokens, waiting } = useInboxReads();
  const figures = useFigures(range);
  const now = useNow();
  const reads = bothViews(workers, waiting);
  return mapView(reads, ([workerList, waitingList]) =>
    overviewOf({
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

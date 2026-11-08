import type { LoadView } from "../ds/loaded";
import type { InboxList } from "../model/inbox";
import type { LeaseList } from "../model/leases";
import { overviewOf, type Overview } from "../model/overview";
import type { ConsoleRange } from "../model/range";
import type { WaitingList } from "../model/waiting";
import type { WorkerList } from "../model/workers";
import { useFigures } from "./figures";
import { useNow, useRouteQuery } from "./live";
import { bothViews, loadView, mapView } from "./resource";

export type {
  EndingCard,
  EndingRow,
  Overview,
  OverviewBanner,
  OverviewTile,
  PlatformCapacity,
  QueueCard,
  QueueRow,
  WallWorker,
} from "../model/overview";

export function useOverview(range: ConsoleRange): LoadView<Overview> {
  const workers = loadView(useRouteQuery<WorkerList>("/v1/workers"));
  const inbox = loadView(useRouteQuery<InboxList>("/v1/inbox"));
  const asked = loadView(useRouteQuery<WaitingList>("/v1/lease-requests"));
  const leases = useRouteQuery<LeaseList>("/v1/leases");
  const figures = useFigures(range);
  const now = useNow();
  // why: a daemon that keeps no queue of its own answers 501, and the Waiting tile then counts none;
  // a refused read is not known, so the Queue and Waiting show it unavailable, never as zero.
  const queueRefusal = asked.kind === "refused" ? asked.message : undefined;
  const waiting: LoadView<WaitingList> =
    asked.kind === "unsupported" || asked.kind === "refused"
      ? { data: { requests: [] }, kind: "ready" }
      : asked;
  return mapView(
    bothViews(bothViews(workers, waiting), inbox),
    ([[workerList, waitingList], inboxList]) =>
      overviewOf({
        updatedAt: now.server,
        figures,
        items: inboxList.items,
        leases: leases.error === undefined ? leases.data?.leases : undefined,
        now: now.server,
        range,
        requests: queueRefusal === undefined ? waitingList.requests : undefined,
        ...(queueRefusal === undefined ? {} : { queueRefusal }),
        workers: workerList.workers,
      }),
  );
}

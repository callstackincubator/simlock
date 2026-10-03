import { Id, PageHeader, Panel, StatCards } from "../layout";
import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { formatDuration } from "../live/time";
import { Link } from "../router";
import { Status, waitingStageStatus } from "../status";
import { type Column, DataTable } from "../table";
import {
  requestedDevice,
  type WaitingList,
  type WaitingRequest,
  waitingOn,
  waitingStats,
} from "./waiting-model";
import { type WorkerList, type WorkerView, workerName, workerPath } from "./workers-model";

/**
 * Every request waiting for a device, from `GET /v1/lease-requests`. `GET /v1/workers` names
 * the worker each one waits on. Time waited counts in the browser (ADR 0013 §4).
 */
export function WaitingView() {
  const requests = useLiveResource<WaitingList>("/v1/lease-requests");
  const workers = useLiveResource<WorkerList>("/v1/workers");
  const now = useNow();
  return (
    <section className="view">
      <PageHeader
        title="Waiting"
        subtitle="Requests waiting for a device, oldest first, and their place in the queue."
      />
      <Loaded state={requests}>
        {(list) => (
          <>
            <StatCards stats={waitingStats(list.requests, now.server)} />
            <Panel
              title="Waiting requests"
              description="Each leaves this list when it gets its device, fails or is cancelled."
            >
              <WaitingTable
                requests={list.requests}
                workers={workers.data?.workers ?? []}
                now={now.server}
              />
            </Panel>
          </>
        )}
      </Loaded>
    </section>
  );
}

/**
 * One row per waiting request, a page at a time, in the order the daemon lists them: on a
 * gateway its own queue, then each worker's. On a phone each row stacks into a block of
 * labelled lines.
 */
export function WaitingTable(props: {
  readonly requests: readonly WaitingRequest[];
  readonly workers: readonly WorkerView[];
  /** The daemon's time now, for how long each request has waited. */
  readonly now: number;
}) {
  const { now, requests, workers } = props;
  const columns: Column<WaitingRequest>[] = [
    { cell: (request) => request.requesterId, header: "Requester", mono: true },
    { cell: (request) => requestedDevice(request.spec), header: "Device" },
    {
      cell: (request) => <WorkerCell request={request} workers={workers} />,
      header: "Worker",
    },
    {
      cell: (request) => {
        const stage = waitingStageStatus(request.stage);
        return <Status tone={stage.tone}>{stage.word}</Status>;
      },
      header: "Stage",
    },
    { cell: (request) => request.queuePosition ?? "—", header: "Place in queue", numeric: true },
    {
      cell: (request) => formatDuration(now - request.createdAt),
      header: "Waiting for",
      numeric: true,
    },
  ];
  return (
    <DataTable
      label="Waiting requests"
      rows={requests}
      columns={columns}
      rowId={(request) => `${request.workerId ?? ""}/${request.id}`}
      empty="No requests are waiting."
      wide
    />
  );
}

function WorkerCell(props: {
  readonly request: WaitingRequest;
  readonly workers: readonly WorkerView[];
}) {
  const worker = waitingOn(props.request, props.workers);
  if (worker === undefined) {
    const id = props.request.workerId;
    return id === undefined ? "—" : <Id>{id}</Id>;
  }
  return <Link to={workerPath(worker.id)}>{workerName(worker)}</Link>;
}

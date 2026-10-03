import { Id, PageHeader, Panel, StatCards } from "../layout";
import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { formatDuration } from "../live/time";
import { Link } from "../router";
import { Status, waitingStageStatus } from "../status";
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

/** One row per waiting request. On a phone each row stacks into a block of labelled lines. */
export function WaitingTable(props: {
  readonly requests: readonly WaitingRequest[];
  readonly workers: readonly WorkerView[];
  /** The daemon's time now, for how long each request has waited. */
  readonly now: number;
}) {
  const { now, requests, workers } = props;
  if (requests.length === 0) return <p className="muted">No requests are waiting.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Requester</th>
          <th scope="col">Device</th>
          <th scope="col">Worker</th>
          <th scope="col">Stage</th>
          <th scope="col" className="num">
            Place in queue
          </th>
          <th scope="col" className="num">
            Waiting for
          </th>
        </tr>
      </thead>
      <tbody>
        {requests.map((request) => {
          const stage = waitingStageStatus(request.stage);
          return (
            <tr key={`${request.workerId ?? ""}/${request.id}`}>
              <td data-label="Requester" className="mono">
                {request.requesterId}
              </td>
              <td data-label="Device">{requestedDevice(request.spec)}</td>
              <td data-label="Worker">
                <WorkerCell request={request} workers={workers} />
              </td>
              <td data-label="Stage">
                <Status tone={stage.tone}>{stage.word}</Status>
              </td>
              <td data-label="Place in queue" className="num">
                {request.queuePosition ?? "—"}
              </td>
              <td data-label="Waiting for" className="num">
                {formatDuration(now - request.createdAt)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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

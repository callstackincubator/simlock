import { MinuteChart, MinuteTable } from "../charts";
import { Id, PageHeader, Panel, StatCards } from "../layout";
import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { Link, usePath } from "../router";
import { useRecentEvents } from "./events";
import { extremes, leaseHistory, type MinuteCount } from "./history-model";
import { WorkerDetail } from "./worker-detail";
import { WorkerFacts } from "./worker-facts";
import {
  busiestWorkers,
  leasesHeld,
  type WorkerList,
  type WorkerView,
  workerIdFrom,
  workerName,
  workerPath,
  workersStats,
} from "./workers-model";

/**
 * The workers views, both fed by `GET /v1/workers` (ADR 0013 §1): the list at `/workers`, and
 * one worker at `/workers/<id>`. On a single host the list has one worker, the host itself. The
 * list's lease chart also reads the last hour of events, as the events view does.
 */
export function WorkersView() {
  const id = workerIdFrom(usePath());
  const state = useLiveResource<WorkerList>("/v1/workers");
  const now = useNow();
  if (id !== undefined) {
    return (
      <section className="view">
        <Loaded state={state}>
          {(list) => <WorkerDetail id={id} workers={list.workers} now={now.server} />}
        </Loaded>
      </section>
    );
  }
  return (
    <section className="view">
      <PageHeader
        title="Workers"
        subtitle="Every worker in the fleet: its connection, its devices and its leases."
      />
      <Loaded state={state}>
        {(list) => (
          <>
            <StatCards stats={workersStats(list.workers)} />
            <div className="panel-row">
              <LeaseHistory workers={list.workers} />
              <BusiestWorkers workers={list.workers} />
            </div>
            <WorkerCards workers={list.workers} />
          </>
        )}
      </Loaded>
    </section>
  );
}

/** The lease chart: today's leases, counted back minute by minute through the last hour's events. */
function LeaseHistory({ workers }: { readonly workers: readonly WorkerView[] }) {
  const events = useRecentEvents();
  const now = useNow();
  const minutes = leaseHistory(leasesHeld(workers), events.data ?? [], now.server);
  return (
    <Panel
      className="panel-wide"
      title="Leases, last hour"
      description="How many leases were held at the end of each minute, counted back from now through the lease events."
    >
      <MinuteChart kind="area" title="Leases, last hour" unit="leases held" minutes={minutes} />
      <LeaseSummary minutes={minutes} />
      <MinuteTable minutes={minutes} heading="Leases held" />
    </Panel>
  );
}

/** The chart's numbers as one line of text: now, and the highest and lowest of the hour. */
function LeaseSummary({ minutes }: { readonly minutes: readonly MinuteCount[] }) {
  const range = extremes(minutes);
  const current = minutes.at(-1);
  if (range === undefined || current === undefined) return null;
  return (
    <p className="chart-summary">
      Now <strong>{current.count}</strong>; highest <strong>{range.highest.count}</strong> at{" "}
      {range.highest.label}; lowest <strong>{range.lowest.count}</strong> at {range.lowest.label}.
    </p>
  );
}

/** Every worker, ranked by how many leases it holds now. Its card below links to its page. */
function BusiestWorkers({ workers }: { readonly workers: readonly WorkerView[] }) {
  return (
    <Panel title="Busiest workers" description="By leases held now, most first.">
      {workers.length === 0 ? (
        <p className="muted">No workers have connected.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col" className="num">
                Leases
              </th>
            </tr>
          </thead>
          <tbody>
            {busiestWorkers(workers).map((worker) => (
              <tr key={worker.id}>
                <td data-label="Worker">
                  {worker.label === undefined ? <Id>{worker.id}</Id> : worker.label}
                </td>
                <td data-label="Leases" className="num">
                  {worker.leases.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** A link to a worker's page, by its label, or by its id on one line when it has none. */
function WorkerLink({ worker }: { readonly worker: WorkerView }) {
  const name = workerName(worker);
  if (worker.label !== undefined) return <Link to={workerPath(worker.id)}>{name}</Link>;
  return (
    <Link to={workerPath(worker.id)} className="id" title={name}>
      {name}
    </Link>
  );
}

function WorkerCards({ workers }: { readonly workers: readonly WorkerView[] }) {
  if (workers.length === 0) return <p className="muted">No workers have connected.</p>;
  return (
    <ul className="cards">
      {workers.map((worker) => (
        <li key={worker.id} className="card">
          <h2 className="card-title">
            <WorkerLink worker={worker} />
          </h2>
          {worker.label === undefined ? null : (
            <p className="muted">
              <Id>{worker.id}</Id>
            </p>
          )}
          <WorkerFacts worker={worker} />
        </li>
      ))}
    </ul>
  );
}

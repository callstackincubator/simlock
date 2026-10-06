import { MinuteChart, MinuteTable } from "../charts";
import { Id, PageHeader, Panel, StatCards } from "../layout";
import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { Pager, usePaging } from "../pager";
import { CARD_SIZES, formatCount } from "../paging";
import { Link, usePath } from "../router";
import { type Column, DataTable } from "../table";
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
  return (
    <Panel
      className="panel-wide"
      title="Leases, last hour"
      description="How many leases were held at the end of each minute, counted back from now through the lease events."
    >
      {/* No history until the events have loaded: a flat line would be a guess. */}
      <Loaded state={events}>
        {(held) => {
          const minutes = leaseHistory(leasesHeld(workers), held, now.server);
          return (
            <>
              <MinuteChart
                kind="area"
                title="Leases, last hour"
                unit="leases held"
                minutes={minutes}
              />
              <LeaseSummary minutes={minutes} />
              <MinuteTable minutes={minutes} heading="Leases held" />
            </>
          );
        }}
      </Loaded>
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

/** How many workers Busiest workers ranks. The cards below have every one. */
const BUSIEST = 5;

const BUSIEST_COLUMNS: readonly Column<WorkerView>[] = [
  {
    cell: (worker) => (worker.label === undefined ? <Id>{worker.id}</Id> : worker.label),
    header: "Worker",
  },
  { cell: (worker) => worker.leases?.length ?? "—", header: "Leases", numeric: true },
];

/**
 * The five workers holding the most leases now, most first, and a link to the cards below for
 * the rest. Each card links to its worker's page.
 */
function BusiestWorkers({ workers }: { readonly workers: readonly WorkerView[] }) {
  return (
    <Panel title="Busiest workers" description="By leases held now, most first.">
      <DataTable
        label="Busiest workers"
        name="busiest"
        rows={busiestWorkers(workers).slice(0, BUSIEST)}
        columns={BUSIEST_COLUMNS}
        rowId={(worker) => worker.id}
        empty="No workers have connected."
      />
      {workers.length <= BUSIEST ? null : (
        <p className="panel-footer">
          <a href={`#${ALL_WORKERS}`}>All {formatCount(workers.length)} workers</a>
        </p>
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

/** The id of the worker cards, where Busiest workers links for the rest. */
const ALL_WORKERS = "all-workers";

/** A card per worker, in the daemon's order, 24 to a page. */
function WorkerCards({ workers }: { readonly workers: readonly WorkerView[] }) {
  const paging = usePaging({ sizes: CARD_SIZES, total: workers.length });
  if (workers.length === 0) return <p className="muted">No workers have connected.</p>;
  const { page, size } = paging.at;
  return (
    <section id={ALL_WORKERS} className="card-list" aria-label="All workers">
      <ul className="cards">
        {workers.slice((page - 1) * size, page * size).map((worker) => (
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
      <Pager label="All workers" paging={paging} />
    </section>
  );
}

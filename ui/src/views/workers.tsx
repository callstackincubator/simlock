import { useLiveResource, useNow } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { Link, usePath } from "../router";
import { WorkerDetail } from "./worker-detail";
import { WorkerFacts } from "./worker-facts";
import {
  type WorkerList,
  type WorkerView,
  workerIdFrom,
  workerName,
  workerPath,
} from "./workers-model";

/**
 * The workers views, both fed by `GET /v1/workers` (ADR 0013 §1): the list at `/workers`, and
 * one worker at `/workers/<id>`. On a single host the list has one worker, the host itself.
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
      <h1>Workers</h1>
      <Loaded state={state}>{(list) => <WorkerCards workers={list.workers} />}</Loaded>
    </section>
  );
}

function WorkerCards({ workers }: { readonly workers: readonly WorkerView[] }) {
  if (workers.length === 0) return <p className="muted">No workers have connected.</p>;
  return (
    <ul className="cards">
      {workers.map((worker) => (
        <li key={worker.id} className="card">
          <h2 className="card-title">
            <Link to={workerPath(worker.id)}>{workerName(worker)}</Link>
          </h2>
          {worker.label === undefined ? null : <p className="muted mono">{worker.id}</p>}
          <WorkerFacts worker={worker} />
        </li>
      ))}
    </ul>
  );
}

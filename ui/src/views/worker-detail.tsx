import { formatDuration } from "../live/time";
import { Link } from "../router";
import { deviceStateStatus, installStatus, Status } from "../status";
import { WorkerFacts } from "./worker-facts";
import {
  platformName,
  stateEnteredAt,
  type WorkerCatalogEntry,
  type WorkerView,
  workerName,
} from "./workers-model";

/** One worker: its facts, its devices, its host, its catalog and its installs in progress. */
export function WorkerDetail(props: {
  readonly id: string;
  readonly workers: readonly WorkerView[];
  /** The daemon's time now, for every duration on the page. */
  readonly now: number;
}) {
  const { id, now, workers } = props;
  const worker = workers.find((candidate) => candidate.id === id);
  return (
    <>
      <p className="back">
        <Link to="/workers">All workers</Link>
      </p>
      {worker === undefined ? (
        <>
          <h1>Worker not found</h1>
          <p className="muted">
            No worker has the id <code>{id}</code>. A gateway forgets a worker that is removed.
          </p>
        </>
      ) : (
        <>
          <h1>{workerName(worker)}</h1>
          {worker.label === undefined ? null : <p className="muted mono">{worker.id}</p>}
          <WorkerFacts worker={worker} />
          <h2>Devices</h2>
          <DeviceTable worker={worker} now={now} />
          <h2>Host</h2>
          <HostFacts worker={worker} />
          <h2>Catalog</h2>
          <Catalog catalog={worker.catalog} />
          <h2>Installs in progress</h2>
          <Installs worker={worker} now={now} />
        </>
      )}
    </>
  );
}

/** Every device on the worker. On a phone each row stacks into a block of labelled lines. */
export function DeviceTable({
  now,
  worker,
}: {
  readonly worker: WorkerView;
  readonly now: number;
}) {
  if (worker.devices.length === 0) return <p className="muted">No devices.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Device</th>
          <th scope="col">State</th>
          <th scope="col">In state for</th>
          <th scope="col">Platform</th>
          <th scope="col">Model</th>
          <th scope="col">Runtime</th>
          <th scope="col">Mode</th>
          <th scope="col">Image tag</th>
        </tr>
      </thead>
      <tbody>
        {worker.devices.map((device) => {
          const state = deviceStateStatus(device.state);
          const since = stateEnteredAt(device, worker);
          return (
            <tr key={device.id}>
              <td data-label="Device" className="mono">
                {device.id}
              </td>
              <td data-label="State">
                <Status tone={state.tone}>{state.word}</Status>
              </td>
              <td data-label="In state for" className="mono">
                {since === undefined ? "—" : formatDuration(now - since)}
              </td>
              <td data-label="Platform">{platformName(device.spec.platform)}</td>
              <td data-label="Model">{device.spec.model}</td>
              <td data-label="Runtime" className="mono">
                {device.spec.osVersion}
              </td>
              <td data-label="Mode">{device.mode}</td>
              <td data-label="Image tag" className="mono">
                {device.spec.imageTag ?? "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HostFacts({ worker }: { readonly worker: WorkerView }) {
  const { host } = worker;
  if (host === undefined) return <p className="muted">Not reported.</p>;
  return (
    <dl className="facts">
      <div>
        <dt>Operating system</dt>
        <dd>
          {host.os} {host.osVersion}
        </dd>
      </div>
      <div>
        <dt>CPU architecture</dt>
        <dd className="mono">{host.arch}</dd>
      </div>
      <div>
        <dt>Tools</dt>
        <dd>
          {host.tools.length === 0 ? (
            "None"
          ) : (
            <ul className="plain-list">
              {host.tools.map((tool) => (
                <li key={`${tool.platform}-${tool.name}`}>
                  {tool.name}{" "}
                  <span className="mono">
                    {tool.version}
                    {tool.build === undefined ? "" : ` (${tool.build})`}
                  </span>{" "}
                  <span className="muted">for {platformName(tool.platform)}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

function Catalog({ catalog }: { readonly catalog: readonly WorkerCatalogEntry[] }) {
  if (catalog.length === 0) return <p className="muted">Nothing reported.</p>;
  return (
    <dl className="facts">
      {catalog.map((entry) => (
        <div key={entry.platform}>
          <dt>{platformName(entry.platform)}</dt>
          <dd>
            <p>
              <span className="muted">Models:</span>{" "}
              {entry.models.length === 0 ? "none" : entry.models.join(", ")}
            </p>
            <p>
              <span className="muted">Runtimes:</span>{" "}
              {entry.runtimes.length === 0
                ? "none"
                : entry.runtimes
                    .map((runtime) =>
                      runtime === entry.defaultRuntime ? `${runtime} (default)` : runtime,
                    )
                    .join(", ")}
            </p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Installs({ now, worker }: { readonly worker: WorkerView; readonly now: number }) {
  const installs = worker.installs ?? [];
  if (installs.length === 0) return <p className="muted">No installs in progress.</p>;
  return (
    <ul className="plain-list">
      {installs.map((install) => {
        const state = installStatus(install.state);
        return (
          <li key={`${install.platform}-${install.component}`}>
            {platformName(install.platform)} <span className="mono">{install.component}</span>{" "}
            <Status tone={state.tone}>{state.word}</Status> for{" "}
            <span className="mono">{formatDuration(now - install.since)}</span>,{" "}
            {install.waiters === 1 ? "1 waiter" : `${install.waiters} waiters`}
          </li>
        );
      })}
    </ul>
  );
}

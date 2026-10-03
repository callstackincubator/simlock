import { Id, PageHeader, Panel } from "../layout";
import { formatDuration } from "../live/time";
import { Link } from "../router";
import { deviceStateStatus, installStatus, Status } from "../status";
import { WorkerLeases } from "./leases";
import { WorkerFacts } from "./worker-facts";
import {
  platformName,
  stateEnteredAt,
  type WorkerCatalogEntry,
  type WorkerView,
  workerName,
} from "./workers-model";

/**
 * One worker: its facts, its devices, its leases, its host, its catalog and its installs in
 * progress.
 */
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
      {worker === undefined ? (
        <>
          <PageHeader title="Worker not found" actions={<AllWorkers />} />
          <p className="muted">
            No worker has the id <code>{id}</code>. A gateway forgets a worker that is removed.
          </p>
        </>
      ) : (
        <>
          <PageHeader
            title={workerName(worker)}
            mono={worker.label === undefined}
            subtitle={
              worker.label === undefined ? (
                "One worker: its devices, leases and host."
              ) : (
                <span className="mono">{worker.id}</span>
              )
            }
            actions={<AllWorkers />}
          />
          <Panel title="Status" description="The worker's connection, health and capacity.">
            <WorkerFacts worker={worker} />
          </Panel>
          <Panel title="Devices" description="Every device on this worker, and its state.">
            <DeviceTable worker={worker} now={now} />
          </Panel>
          <Panel title="Leases" description="The leases on this worker's devices.">
            <WorkerLeases worker={worker} workers={workers} now={now} />
          </Panel>
          <div className="panel-row panel-row-even">
            <Panel title="Host" description="The machine the worker runs on.">
              <HostFacts worker={worker} />
            </Panel>
            <Panel title="Catalog" description="The models and runtimes it can lease.">
              <Catalog catalog={worker.catalog} />
            </Panel>
          </div>
          <Panel
            title="Installs in progress"
            description="Runtimes and system images being downloaded, or waiting to be."
          >
            <Installs worker={worker} now={now} />
          </Panel>
        </>
      )}
    </>
  );
}

function AllWorkers() {
  return (
    <Link to="/workers" className="button button-secondary">
      All workers
    </Link>
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
          <th scope="col" className="num">
            In state for
          </th>
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
              <td data-label="Device">
                <Id>{device.id}</Id>
              </td>
              <td data-label="State">
                <Status tone={state.tone}>{state.word}</Status>
              </td>
              <td data-label="In state for" className="num">
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

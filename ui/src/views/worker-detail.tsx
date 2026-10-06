import { Id, PageHeader, Panel } from "../layout";
import { formatDuration } from "../live/time";
import { Link } from "../router";
import { deviceStateStatus, installStatus, Status } from "../status";
import { type Column, DataTable } from "../table";
import { WorkerLeases } from "./leases";
import { WorkerFacts } from "./worker-facts";
import {
  platformName,
  stateEnteredAt,
  type WorkerCatalogEntry,
  type WorkerDevice,
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
          {worker.health === "starting" ? (
            <>
              <Panel title="Host" description="The machine the worker runs on.">
                <HostFacts worker={worker} />
              </Panel>
              <p className="muted">Devices, leases and capacity appear once startup finishes.</p>
            </>
          ) : (
            <WorkerReads worker={worker} workers={workers} now={now} />
          )}
        </>
      )}
    </>
  );
}

/** What a worker that has finished starting reports: its devices, leases, host, catalog and installs. */
function WorkerReads(props: {
  readonly worker: WorkerView;
  readonly workers: readonly WorkerView[];
  readonly now: number;
}) {
  const { now, worker, workers } = props;
  return (
    <>
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
          <Catalog catalog={worker.catalog ?? []} />
        </Panel>
      </div>
      <Panel
        title="Warm pool"
        description="The devices the worker keeps booted ahead of demand, and why a target is short."
      >
        <WarmPool worker={worker} />
      </Panel>
      <Panel
        title="Installs in progress"
        description="Runtimes and system images being downloaded, or waiting to be."
      >
        <Installs worker={worker} now={now} />
      </Panel>
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

/**
 * Every device on the worker, a page at a time, in the order the worker lists them. On a phone
 * each row stacks into a block of labelled lines.
 */
export function DeviceTable({
  now,
  worker,
}: {
  readonly worker: WorkerView;
  readonly now: number;
}) {
  const columns: Column<WorkerDevice>[] = [
    { cell: (device) => <Id>{device.id}</Id>, header: "Device" },
    {
      cell: (device) => {
        const state = deviceStateStatus(device.state);
        return <Status tone={state.tone}>{state.word}</Status>;
      },
      header: "State",
    },
    {
      cell: (device) => {
        const since = stateEnteredAt(device, worker);
        return since === undefined ? "—" : formatDuration(now - since);
      },
      header: "In state for",
      numeric: true,
    },
    { cell: (device) => platformName(device.spec.platform), header: "Platform" },
    { cell: (device) => device.spec.model, header: "Model" },
    { cell: (device) => device.spec.osVersion, header: "Runtime", mono: true },
    { cell: (device) => device.mode, header: "Mode" },
    { cell: (device) => device.spec.imageTag ?? "—", header: "Image tag", mono: true },
  ];
  return (
    <DataTable
      label="Devices"
      name="devices"
      rows={worker.devices ?? []}
      columns={columns}
      rowId={(device) => device.id}
      empty="No devices."
      wide
    />
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

type WarmTarget = NonNullable<WorkerView["warmPool"]>["targets"][number];

/**
 * The worker's warm pool: whether it is on, the slots it holds back, and each target with the
 * four numbers and the reason it is short, as the worker sent them.
 */
function WarmPool({ worker }: { readonly worker: WorkerView }) {
  const { warmPool } = worker;
  if (warmPool === undefined) return <p className="muted">Not reported.</p>;
  const columns: Column<WarmTarget>[] = [
    { cell: (target) => target.model, header: "Model" },
    { cell: (target) => target.osVersion ?? "—", header: "Runtime", mono: true },
    { cell: (target) => target.mode, header: "Mode" },
    { cell: (target) => target.count, header: "Wanted", numeric: true },
    { cell: (target) => target.ready, header: "Ready", numeric: true },
    { cell: (target) => target.booting, header: "Booting", numeric: true },
    { cell: (target) => target.short ?? "—", header: "Short", mono: true },
  ];
  return (
    <>
      <dl className="facts">
        <div>
          <dt>Pool</dt>
          <dd>{warmPool.enabled ? "On" : "Off"}</dd>
        </div>
        <div>
          <dt>Reserved running slots</dt>
          <dd>
            iOS {warmPool.reserveRunning.ios}, Android {warmPool.reserveRunning.android}
          </dd>
        </div>
      </dl>
      <DataTable
        label="Warm pool"
        name="warm-pool"
        rows={warmPool.targets}
        columns={columns}
        rowId={(target) => `${target.platform}-${target.model}-${target.osVersion}-${target.mode}`}
        empty="No targets."
        wide
      />
    </>
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

import "./workers.css";

import { useState } from "react";

import {
  Card,
  ChoiceChips,
  type Column,
  DataTable,
  Empty,
  Facts,
  Grid,
  Id,
  Inspector,
  InspectorEmpty,
  Link,
  List,
  ListPane,
  ListRow,
  Loaded,
  MasterDetail,
  Meter,
  Pager,
  Panel,
  SlotLegend,
  Slots,
  Status,
  StatusDot,
  Tabs,
} from "../../ds";
import {
  type CapabilityRow,
  type DeviceRow,
  type FigureCard,
  type InstallRow,
  type PlatformCard,
  useWorkers,
  type WarmRow,
  WORKER_FILTERS,
  type WorkerInspectorView,
  type WorkerRow,
  type WorkersPage,
  type WorkerTab,
} from "../../state/workers";

export function WorkersScreen() {
  const view = useWorkers();
  return <Loaded view={view}>{(page) => <WorkersBody page={page} />}</Loaded>;
}

export function WorkersBody({
  initialTab = "overview",
  page,
}: {
  readonly page: WorkersPage;
  readonly initialTab?: WorkerTab;
}) {
  return (
    <MasterDetail
      focus={page.focus}
      wide
      list={<WorkerList page={page} />}
      detail={
        page.inspector === undefined ? (
          <MissingWorker id={page.missing} />
        ) : (
          <WorkerDetail
            key={page.inspector.id}
            inspector={page.inspector}
            initialTab={initialTab}
          />
        )
      }
    />
  );
}

function WorkerList({ page }: { readonly page: WorkersPage }) {
  return (
    <ListPane
      title="Workers"
      meta={page.meta}
      toolbar={
        <ChoiceChips
          legend="Show workers"
          choices={WORKER_FILTERS}
          value={page.filter}
          onChange={page.setFilter}
        />
      }
      footer={<Pager label="Workers" paging={page.paging} />}
    >
      {page.rows.length === 0 ? (
        <Empty>{page.empty ? "No workers have connected." : "No worker matches."}</Empty>
      ) : (
        <List label="Workers">
          {page.rows.map((row) => (
            <WorkerListRow key={row.id} row={row} selected={row.id === page.chosen} />
          ))}
        </List>
      )}
    </ListPane>
  );
}

function WorkerListRow({ row, selected }: { readonly row: WorkerRow; readonly selected: boolean }) {
  return (
    <ListRow
      to={row.to}
      selected={selected}
      mono={row.mono}
      lead={<StatusDot tone={row.health.tone} label={row.health.word} />}
      title={row.name}
      aside={row.use === undefined ? "—" : `${row.use.running} / ${row.use.limit}`}
      sub={
        row.use === undefined ? undefined : (
          <Meter percent={row.use.percent} tone="neutral" size="thin" />
        )
      }
    />
  );
}

function MissingWorker({ id }: { readonly id: string | undefined }) {
  if (id === undefined) return <InspectorEmpty>Nothing to show.</InspectorEmpty>;
  return (
    <InspectorEmpty>
      Worker not found. <Link to="/workers">All workers</Link>
    </InspectorEmpty>
  );
}

function WorkerDetail({
  initialTab,
  inspector,
}: {
  readonly inspector: WorkerInspectorView;
  readonly initialTab: WorkerTab;
}) {
  const [tab, setTab] = useState<WorkerTab>(initialTab);
  return (
    <Inspector
      crumbs={[{ label: "Workers", to: "/workers" }, { label: inspector.title }]}
      title={inspector.title}
      mono={inspector.mono}
      line={
        <>
          <Status tone={inspector.health.tone}>{inspector.health.word}</Status>
          {inspector.os === undefined ? null : <span>· {inspector.os}</span>}
          {inspector.version === undefined ? null : <span>· {inspector.version}</span>}
        </>
      }
    >
      <Tabs label="Worker" tabs={inspector.tabs} value={tab} onChange={setTab}>
        {tab === "overview" ? <OverviewTab inspector={inspector} /> : null}
        {tab === "host" ? <HostTab inspector={inspector} /> : null}
        {tab === "warm-pool" ? <WarmTab inspector={inspector} /> : null}
      </Tabs>
    </Inspector>
  );
}

function OverviewTab({ inspector }: { readonly inspector: WorkerInspectorView }) {
  const { overview } = inspector;
  if (overview.incompatible) {
    return (
      <Panel title="Protocol">
        <ProtocolFacts inspector={inspector} />
      </Panel>
    );
  }
  return (
    <>
      <Grid min="sm" label="Load and leases">
        {overview.figures.map((card) => (
          <FigureCardView key={card.label} card={card} />
        ))}
        {overview.loadNote === undefined ? null : (
          <Card>
            <p className="figure-label">Load</p>
            <p className="figure-text">{overview.loadNote}</p>
          </Card>
        )}
        {overview.leases === undefined ? null : (
          <Card>
            <p className="figure-label">Leases</p>
            <p className="figure-count mono">{overview.leases.count}</p>
            {overview.leases.running === undefined ? null : (
              <p className="figure-detail">
                <span className="muted">Running</span> {overview.leases.running}
              </p>
            )}
          </Card>
        )}
      </Grid>
      {overview.read === undefined ? null : (
        <p className="muted figure-read">Read {overview.read}</p>
      )}
      {overview.starting ? (
        <p className="muted">Devices, leases and capacity appear once startup finishes.</p>
      ) : (
        <>
          <PlatformCards platforms={overview.platforms} />
          <Panel title="Devices" flush>
            <DataTable
              label="Devices"
              rows={overview.devices ?? []}
              columns={DEVICE_COLUMNS}
              rowId={(device) => device.id}
              empty="No devices."
              paging={inspector.devicesPaging}
              wide
            />
          </Panel>
        </>
      )}
    </>
  );
}

function FigureCardView({ card }: { readonly card: FigureCard }) {
  return (
    <Card>
      <p className="figure-label">{card.label}</p>
      <p className="figure-text">{card.text}</p>
      {card.percent === undefined ? null : <Meter percent={card.percent} tone={card.tone} />}
      {card.details.map((detail) => (
        <p key={detail.label} className="figure-detail">
          <span className="muted">{detail.label}</span>{" "}
          {detail.tone === undefined ? (
            detail.text
          ) : (
            <Status tone={detail.tone}>{detail.text}</Status>
          )}
        </p>
      ))}
    </Card>
  );
}

function PlatformCards({ platforms }: { readonly platforms: readonly PlatformCard[] }) {
  if (platforms.length === 0) return <p className="muted">Capacity not reported.</p>;
  return (
    <>
      <Grid min="lg" label="Capacity">
        {platforms.map((platform) => (
          <Card key={platform.name}>
            <p className="platform-head">
              <span>{platform.name}</span>
              <span className="mono">
                {platform.running} <span className="muted">of {platform.limit} running</span>
              </span>
            </p>
            <Slots size="lg" slots={platform.slots} label={platform.label} />
          </Card>
        ))}
      </Grid>
      <SlotLegend />
    </>
  );
}

const DEVICE_COLUMNS: readonly Column<DeviceRow>[] = [
  {
    cell: (device) => (
      <span className="device-name">
        <StatusDot tone={device.status.tone} label={device.status.word} />
        <span className="device-text">
          <span>
            {device.model} <span className="mono muted">{device.runtime}</span>
          </span>
          <span className="device-sub">
            {device.platform} · <Id>{device.id}</Id>
          </span>
        </span>
      </span>
    ),
    header: "Device",
  },
  {
    cell: (device) =>
      device.holder === undefined ? (
        device.status.word
      ) : (
        <span className="device-text">
          <Link to={device.holder.to} title={device.holder.name}>
            {device.holder.name}
          </Link>
          {device.renewed === undefined ? null : (
            <span className="device-sub">renewed {device.renewed}</span>
          )}
        </span>
      ),
    header: "Holder",
  },
  {
    cell: (device) => (
      <span className="device-text">
        <span>{device.since ?? "—"}</span>
        {device.expires === undefined ? null : (
          <span className="device-sub">expires in {device.expires}</span>
        )}
      </span>
    ),
    header: "In state for",
  },
  {
    cell: (device) => (
      <span className="device-text">
        <span>{device.physical ? "Physical" : "Virtual"}</span>
        {device.mode === undefined && device.imageTag === undefined ? null : (
          <span className="device-sub">
            {[device.mode, device.imageTag].filter((part) => part !== undefined).join(" · ")}
          </span>
        )}
      </span>
    ),
    header: "Type",
  },
];

function ProtocolFacts({ inspector }: { readonly inspector: WorkerInspectorView }) {
  const { protocol } = inspector.host;
  return protocol.compatible ? (
    <Status tone="ok">compatible</Status>
  ) : (
    <>
      <Status tone="error">incompatible</Status>
      {protocol.ranges === undefined ? null : <span className="mono"> {protocol.ranges}</span>}
    </>
  );
}

function HostTab({ inspector }: { readonly inspector: WorkerInspectorView }) {
  const { host } = inspector;
  return (
    <>
      <Panel title="Host">
        <Facts
          facts={[
            { label: "Worker id", value: <span className="mono">{host.id}</span> },
            {
              label: "Connection",
              value: (
                <span className="host-statuses">
                  <Status tone={host.connection.tone}>{host.connection.word}</Status>
                  {host.drained ? <Status tone="warn">drained</Status> : null}
                </span>
              ),
            },
            {
              label: "Health",
              value:
                host.health === undefined ? (
                  "Not reported"
                ) : (
                  <Status tone={host.health.tone}>{host.health.word}</Status>
                ),
            },
            { label: "Protocol", value: <ProtocolFacts inspector={inspector} /> },
            ...(host.host === undefined
              ? [{ label: "Host", value: "Not reported" }]
              : [
                  { label: "Operating system", value: host.host.os },
                  {
                    label: "CPU architecture",
                    value: <span className="mono">{host.host.arch}</span>,
                  },
                  {
                    label: "Tools",
                    value:
                      host.host.tools.length === 0 ? (
                        "None"
                      ) : (
                        <ul className="plain-list">
                          {host.host.tools.map((tool) => (
                            <li key={tool.key}>
                              {tool.name} <span className="mono">{tool.version}</span>{" "}
                              <span className="muted">for {tool.platform}</span>
                            </li>
                          ))}
                        </ul>
                      ),
                  },
                ]),
          ]}
        />
      </Panel>
      {host.capabilities === undefined ? null : (
        <Panel title="Capabilities">
          <Capabilities rows={host.capabilities} />
        </Panel>
      )}
      <Panel title="Catalog">
        {host.catalog.length === 0 ? (
          <p className="muted">Nothing reported.</p>
        ) : (
          <Facts
            facts={host.catalog.map((entry) => ({
              label: entry.platform,
              value: (
                <>
                  <p>
                    <span className="muted">Models:</span> {entry.models}
                  </p>
                  <p>
                    <span className="muted">Runtimes:</span> {entry.runtimes}
                  </p>
                </>
              ),
            }))}
          />
        )}
      </Panel>
    </>
  );
}

function Capabilities({ rows }: { readonly rows: readonly CapabilityRow[] | "not-reported" }) {
  if (rows === "not-reported") return <p className="muted">Not reported.</p>;
  return (
    <Facts
      facts={rows.map((row) => ({
        label: row.name,
        value: (
          <>
            <Status tone={row.tone}>{row.state}</Status>
            {row.reason === undefined ? null : ` ${row.reason}`}
          </>
        ),
      }))}
    />
  );
}

const WARM_COLUMNS: readonly Column<WarmRow>[] = [
  { cell: (target) => target.model, header: "Model" },
  { cell: (target) => target.runtime, header: "Runtime", mono: true },
  { cell: (target) => target.mode, header: "Mode" },
  { cell: (target) => target.wanted, header: "Wanted", numeric: true },
  { cell: (target) => target.ready, header: "Ready", numeric: true },
  { cell: (target) => target.booting, header: "Booting", numeric: true },
  { cell: (target) => target.short, header: "Short", mono: true },
];

function WarmTab({ inspector }: { readonly inspector: WorkerInspectorView }) {
  const { warm } = inspector;
  if (warm === undefined) return null;
  return (
    <>
      <Panel title="Warm pool">
        {warm.pool === undefined ? (
          <p className="muted">Not reported.</p>
        ) : (
          <>
            <Facts
              facts={[
                { label: "Pool", value: warm.pool.enabled },
                { label: "Reserved running slots", value: warm.pool.reserve },
              ]}
            />
            <DataTable
              label="Warm pool"
              rows={warm.targets}
              columns={WARM_COLUMNS}
              rowId={(row) => row.key}
              empty="No targets."
              paging={inspector.warmPaging}
              wide
            />
          </>
        )}
      </Panel>
      <Panel title="Installs in progress">
        <Installs rows={warm.installs} />
      </Panel>
    </>
  );
}

function Installs({ rows }: { readonly rows: readonly InstallRow[] }) {
  if (rows.length === 0) return <p className="muted">No installs in progress.</p>;
  return (
    <ul className="plain-list">
      {rows.map((install) => (
        <li key={install.key}>
          {install.platform} <span className="mono">{install.component}</span>{" "}
          <Status tone={install.status.tone}>{install.status.word}</Status> for{" "}
          <span className="mono">{install.duration}</span>, {install.waiters}
        </li>
      ))}
    </ul>
  );
}

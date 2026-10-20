import {
  Card,
  type Column,
  DataTable,
  Facts,
  Grid,
  Id,
  Link,
  Loaded,
  Meter,
  Page,
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
  type EventRow,
  type FigureCard,
  type InstallRow,
  type PlatformCard,
  useWorkerEvents,
  useWorkerPage,
  type WarmRow,
  type WorkerPageView,
} from "../../state/workers";
import { DeviceDrawer } from "./device-drawer";

export function WorkerPageScreen(props: {
  readonly id: string;
  readonly deviceId: string | undefined;
}) {
  const { deviceId, id } = props;
  const view = useWorkerPage(id);
  return (
    <>
      <Loaded view={view}>
        {(page) => (page === undefined ? <MissingWorker /> : <WorkerPageBody page={page} />)}
      </Loaded>
      {deviceId === undefined ? null : (
        <DeviceDrawer key={deviceId} workerId={id} deviceId={deviceId} />
      )}
    </>
  );
}

function MissingWorker() {
  return (
    <Page title="Worker">
      <p className="muted">
        This worker is not in the fleet. <Link to="/fleet">Back to Fleet</Link>
      </p>
    </Page>
  );
}

export function WorkerPageBody({ page }: { readonly page: WorkerPageView }) {
  return (
    <Page title={page.title}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="crumb">
          <Link to={page.back}>Fleet</Link>
        </span>
      </nav>
      <p className="worker-line">
        <Status tone={page.health.tone}>{page.health.word}</Status>
        {page.system === undefined ? null : <> · {page.system}</>}
      </p>
      {page.banners.map((banner) => (
        <p key={banner} className="worker-banner">
          {banner}
        </p>
      ))}
      <Overview page={page} />
      <Tabs label="Worker" tabs={page.tabs} value={page.tab} onChange={page.chooseTab}>
        {page.tab === "devices" ? <DevicesTab page={page} /> : null}
        {page.tab === "host" ? <HostTab inspector={page} /> : null}
        {page.tab === "warm-pool" ? <WarmTab inspector={page} /> : null}
        {page.tab === "events" ? <WorkerEvents id={page.id} /> : null}
      </Tabs>
    </Page>
  );
}

function Overview({ page }: { readonly page: WorkerPageView }) {
  const { overview } = page;
  if (overview.incompatible) return null;
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
      {overview.starting ? null : <PlatformCards platforms={overview.platforms} />}
    </>
  );
}

function DevicesTab({ page }: { readonly page: WorkerPageView }) {
  const { overview } = page;
  if (overview.incompatible) {
    return <p className="muted">No devices: the gateway cannot read this worker.</p>;
  }
  if (overview.starting) {
    return <p className="muted">Devices, leases and capacity appear once startup finishes.</p>;
  }
  return (
    <Panel title="Devices" flush>
      <DataTable
        label="Devices"
        rows={overview.devices ?? []}
        columns={DEVICE_COLUMNS}
        rowId={(device) => device.id}
        rowTo={(device) => device.to}
        empty="No devices."
        paging={page.devicesPaging}
        wide
      />
    </Panel>
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
            <Link to={device.to}>{device.model}</Link>{" "}
            <span className="mono muted">{device.runtime}</span>
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

function ProtocolFacts({ inspector }: { readonly inspector: WorkerPageView }) {
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

function HostTab({ inspector }: { readonly inspector: WorkerPageView }) {
  const { host } = inspector;
  return (
    <>
      <Panel title="Host">
        <Facts
          facts={[
            { label: "Worker id", value: <span className="mono">{host.id}</span> },
            ...(host.version === undefined
              ? []
              : [{ label: "Version", value: <span className="mono">{host.version}</span> }]),
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

function WarmTab({ inspector }: { readonly inspector: WorkerPageView }) {
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

function WorkerEvents({ id }: { readonly id: string }) {
  const view = useWorkerEvents(id);
  return <Loaded view={view}>{(rows) => <WorkerEventList rows={rows} />}</Loaded>;
}

function WorkerEventList({ rows }: { readonly rows: readonly EventRow[] }) {
  if (rows.length === 0) {
    return <p className="muted">No events for this worker in the last hour.</p>;
  }
  return (
    <ul className="worker-events" aria-label="Events for this worker">
      {rows.map((row) => (
        <li key={row.id}>
          <time dateTime={row.iso} className="mono muted">
            {row.time}
          </time>
          <span className="mono">{row.name}</span>
          <span className="muted">{row.summary}</span>
        </li>
      ))}
    </ul>
  );
}

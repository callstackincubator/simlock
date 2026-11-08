import {
  ActionBar,
  AgentChip,
  Button,
  type Column,
  DataTable,
  Facts,
  Feed,
  Link,
  Loaded,
  type LoadView,
  LogRow,
  Meter,
  Page,
  Pill,
  Ring,
  Slots,
  StatusDot,
  Status,
  Tabs,
  useNavigateTo,
} from "../../ds";
import {
  type DeviceRow,
  type LogEventRow,
  type InstallRow,
  useWorkerEvents,
  useWorkerPage,
  useWorkerPageMenu,
  type WorkerEventsPage,
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
  const log = useWorkerEvents(id);
  return (
    <>
      <Loaded view={view}>
        {(page) =>
          page === undefined ? <MissingWorker /> : <WorkerPageBody page={page} log={log} />
        }
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

export function WorkerPageBody({
  log,
  page,
}: {
  readonly page: WorkerPageView;
  readonly log: LoadView<WorkerEventsPage>;
}) {
  const entries = useWorkerPageMenu(page);
  const again = entries.find((entry) => entry.key === "update-worker");
  return (
    <Page
      title={page.title}
      crumb={{ label: "Fleet", to: page.back }}
      status={<Pill tone={page.health.tone}>{page.health.word}</Pill>}
      actions={<ActionBar label={`Actions for ${page.title}`} entries={entries} />}
    >
      {page.banners.map((banner) => (
        <p
          key={banner.text}
          className={
            banner.tone === "error" ? "worker-banner worker-banner-error" : "worker-banner"
          }
        >
          {banner.text}
          {banner.failure === true && again !== undefined ? (
            <Button onClick={again.onSelect}>Update again</Button>
          ) : null}
        </p>
      ))}
      <Gauges page={page} />
      <div className="worker-grid">
        <SideCard page={page} />
        <MainCard page={page} log={log} />
      </div>
    </Page>
  );
}

function Gauge(props: {
  readonly label: string;
  readonly percent?: number | undefined;
  readonly tone: "ok" | "warn" | "error" | "idle" | "neutral";
  readonly big: string;
  readonly small: string;
}) {
  return (
    <div className="worker-gauge">
      <Ring
        bare
        label={props.label}
        tone={props.tone}
        {...(props.percent === undefined ? {} : { percent: props.percent })}
      />
      <div className="worker-gauge-text">
        <span className="fleet-label">{props.label}</span>
        <strong title={props.big}>{props.big}</strong>
        <span title={props.small}>{props.small}</span>
      </div>
    </div>
  );
}

function Gauges({ page }: { readonly page: WorkerPageView }) {
  const { overview } = page;
  if (overview.incompatible) return null;
  return (
    <div className="worker-gauges" role="group" aria-label="Load and leases">
      {overview.figures.map((card) => (
        <Gauge
          key={card.label}
          label={card.label}
          percent={card.percent}
          tone={card.tone}
          big={card.big}
          small={card.small}
        />
      ))}
      {overview.loadNote === undefined ? null : (
        <div className="worker-gauge">
          <div className="worker-gauge-text">
            <span className="fleet-label">Load</span>
            <strong>{overview.loadNote}</strong>
          </div>
        </div>
      )}
      {overview.slots === undefined ? null : (
        <Gauge
          label="Slots"
          percent={overview.slots.percent}
          tone="neutral"
          big={overview.slots.big}
          small={overview.slots.small}
        />
      )}
    </div>
  );
}

function SideCard({ page }: { readonly page: WorkerPageView }) {
  const { host, overview } = page;
  const mono = (text: string) => <span className="mono">{text}</span>;
  const facts = [
    ...(host.host === undefined
      ? []
      : [
          { label: host.host.osName, value: mono(host.host.osVersion) },
          ...host.host.tools.map((tool) => ({
            label: tool.name,
            value: mono(tool.version),
          })),
        ]),
    ...(host.version === undefined ? [] : [{ label: "simlock", value: mono(host.version) }]),
    ...(host.warm === undefined ? [] : [{ label: "Warm pool", value: mono(host.warm) }]),
    ...(host.protocol.compatible
      ? []
      : [
          {
            label: "Protocol",
            value: (
              <>
                <Status tone="error">incompatible</Status>
                {host.protocol.ranges === undefined ? null : (
                  <span className="mono"> {host.protocol.ranges}</span>
                )}
              </>
            ),
          },
        ]),
    {
      label: "Worker id",
      value: <span className="mono worker-id">{host.id}</span>,
    },
  ];
  return (
    <aside className="worker-side" aria-label="Slots, host, capabilities and baselines">
      {overview.platforms.length === 0 ? null : (
        <section>
          <h2 className="fleet-label">Slots</h2>
          <div className="worker-side-slots">
            {overview.platforms.map((platform) => (
              <div key={platform.name} className="worker-side-row">
                <span className="worker-side-name">{platform.name}</span>
                <Slots slots={platform.slots} label={platform.label} />
                <span className="mono worker-side-fraction">
                  {platform.slots.filter((slot) => slot.kind === "leased").length} /{" "}
                  {platform.slots.length}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2 className="fleet-label">Host</h2>
        <Facts facts={facts} />
      </section>
      {Array.isArray(host.capabilities) && host.capabilities.length > 0 ? (
        <section>
          <h2 className="fleet-label">Capabilities</h2>
          <ul className="worker-caps">
            {host.capabilities.map((row) => (
              <li key={row.name} title={row.reason}>
                <span>{row.name}</span>
                <Pill tone={row.tone}>{row.state === "available" ? "on" : row.state}</Pill>
                {row.reason === undefined ? null : (
                  <span className="muted worker-cap-reason">{row.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h2 className="fleet-label">Baselines here</h2>
        {host.baselines.length === 0 ? (
          <p className="muted worker-side-none">None.</p>
        ) : (
          <ul className="worker-baselines">
            {host.baselines.map((baseline) => (
              <li key={baseline.key}>
                <span className="mono" title={baseline.name}>
                  {baseline.name}
                </span>
                <span className="mono">
                  {baseline.stale === undefined ? baseline.size : "stale"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function MainCard({
  log,
  page,
}: {
  readonly page: WorkerPageView;
  readonly log: LoadView<WorkerEventsPage>;
}) {
  return (
    <div className="worker-main">
      <div className="worker-main-top">
        <Tabs label="Worker" tabs={page.tabs} value={page.tab} onChange={page.chooseTab}>
          {page.tab === "devices" ? <DevicesTab page={page} /> : <WarmTab inspector={page} />}
        </Tabs>
      </div>
      <WorkerEvents key={page.id} view={log} />
    </div>
  );
}

function DevicesTab({ page }: { readonly page: WorkerPageView }) {
  const { overview } = page;
  if (overview.incompatible) {
    return <p className="muted worker-note">No devices: the gateway cannot read this worker.</p>;
  }
  if (overview.starting) {
    return (
      <p className="muted worker-note">
        Devices, leases and capacity appear once startup finishes.
      </p>
    );
  }
  const devices = overview.devices ?? [];
  if (devices.length === 0) return <p className="muted worker-note">No devices.</p>;
  return <DeviceTable devices={devices} watchTo={page.streamTo} />;
}

function holderOf(device: DeviceRow) {
  const { holder } = device;
  if (holder === undefined) return <span className="device-since">—</span>;
  return (
    <span className="device-held">
      <AgentChip kind={holder.kind} title={holder.name} />
      <span className="mono device-holder" title={holder.name}>
        {holder.display}
      </span>
    </span>
  );
}

function DeviceTable(props: {
  readonly devices: readonly DeviceRow[];
  readonly watchTo: (deviceId: string) => string;
}) {
  const navigate = useNavigateTo();
  const columns: readonly Column<DeviceRow>[] = [
    {
      cell: (device) => (
        <>
          <Link className="worker-device-name cell-line" to={device.to} title={device.model}>
            {device.model}
          </Link>
          <span className="mono cell-line" title={`${device.platform} ${device.runtime}`}>
            {device.platform} {device.runtime}
          </span>
        </>
      ),
      className: "device-name-cell",
      header: "Device",
      width: "190px",
    },
    {
      cell: (device) => (
        <Pill tone={device.status.tone} plain={device.status.word === "leased"}>
          {device.status.word}
        </Pill>
      ),
      header: "State",
      width: "96px",
    },
    { cell: holderOf, drop: 2, header: "Held by" },
    {
      cell: (device) =>
        device.holder === undefined || device.ttl === undefined ? (
          <span className="device-since">—</span>
        ) : (
          <span
            className="device-expires"
            title={device.expires === undefined ? undefined : `expires in ${device.expires}`}
          >
            <b className="mono">{device.ttl}</b>
            {device.ttlPercent === undefined ? null : (
              <Meter percent={device.ttlPercent} tone={device.ttlTone} size="thin" />
            )}
          </span>
        ),
      drop: 3,
      header: "Expires in",
      width: "136px",
    },
    {
      cell: (device) => (
        <span className="device-since" title={device.timeNote}>
          {device.timeNote ?? "—"}
        </span>
      ),
      drop: 1,
      header: "Since",
      width: "116px",
    },
    {
      cell: (device) => {
        const watch = device.watchable ? props.watchTo(device.id) : "";
        return watch === "" ? null : (
          <Link className="button button-secondary button-sm" to={watch}>
            Watch
          </Link>
        );
      },
      className: "device-actions",
      header: "Watch",
      hideHeader: true,
      width: "84px",
    },
  ];
  return (
    <DataTable
      label="Devices"
      rows={props.devices}
      columns={columns}
      rowId={(device) => device.id}
      empty="No devices."
      footer="count"
      className="table-lines"
      wide
      menu={{
        entries: (device) => [
          {
            danger: false,
            disabled: false,
            key: "details",
            label: "Open details",
            onSelect: () => navigate?.(device.to),
          },
          ...(device.lease === undefined
            ? []
            : [
                {
                  danger: false,
                  disabled: false,
                  key: "lease",
                  label: "Open lease",
                  onSelect: () => navigate?.(device.lease?.to ?? device.to),
                },
              ]),
        ],
        label: (device) => `Actions for ${device.model}`,
      }}
    />
  );
}

const WARM_COLUMNS: readonly Column<WarmRow>[] = [
  {
    cell: (target) => <span title={target.model}>{target.model}</span>,
    header: "Model",
    width: "200px",
  },
  { cell: (target) => target.runtime, drop: 3, header: "Runtime", mono: true, width: "90px" },
  { cell: (target) => target.mode, drop: 2, header: "Mode", width: "90px" },
  { cell: (target) => target.origin, drop: 1, header: "Origin", width: "110px" },
  { cell: (target) => target.wanted, header: "Wanted", numeric: true, width: "90px" },
  { cell: (target) => target.ready, header: "Ready", numeric: true, width: "90px" },
  { cell: (target) => target.booting, drop: 4, header: "Booting", numeric: true, width: "90px" },
  { cell: (target) => target.short, header: "Short", numeric: true, width: "90px" },
];

function WarmTab({ inspector }: { readonly inspector: WorkerPageView }) {
  const { warm } = inspector;
  if (warm === undefined) return null;
  return (
    <div className="worker-warm">
      <section aria-label="Warm pool facts">
        <h2 className="fleet-label">Warm pool</h2>
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
              className="table-lines"
              wide
            />
          </>
        )}
      </section>
      <section aria-label="Installs in progress">
        <h2 className="fleet-label">Installs in progress</h2>
        <Installs rows={warm.installs} />
      </section>
    </div>
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

// why: one row of the feed is as tall as the feed says, so the rows can be placed by arithmetic.
const EVENT_ROW_PX = 30;

function WorkerEvents({ view }: { readonly view: LoadView<WorkerEventsPage> }) {
  return (
    <section className="worker-log" aria-label="Events on this worker">
      <header className="fleet-log-head">
        <h2 className="fleet-label">Events on this worker</h2>
        <Pill tone="ok">live</Pill>
      </header>
      <Loaded view={view}>
        {(page) => <WorkerEventFeed rows={page.rows} end={page.end} loadOlder={page.loadOlder} />}
      </Loaded>
    </section>
  );
}

function WorkerEventFeed({
  end,
  loadOlder,
  rows,
}: {
  readonly rows: readonly LogEventRow[];
  readonly end: WorkerEventsPage["end"];
  readonly loadOlder: () => void;
}) {
  const endRow =
    end === undefined ? null : (
      <p className="feed-end muted">
        {end.text}
        {end.retry ? (
          <Button type="button" onClick={loadOlder}>
            Try again
          </Button>
        ) : null}
      </p>
    );
  if (rows.length === 0) return endRow ?? <p className="muted worker-note">Loading…</p>;
  return (
    <Feed
      label="Event feed for this worker"
      listLabel="Events for this worker"
      count={rows.length}
      rowHeight={EVENT_ROW_PX}
      keyAt={(index) => rows[index]?.id ?? String(index)}
      newText={(count) => (count === 1 ? "1 new event" : `${count} new events`)}
      onNearEnd={loadOlder}
      footer={endRow}
      renderRow={(index) => {
        const row = rows[index];
        return row === undefined ? null : (
          <li className="list-item">
            <LogRow
              time={<time dateTime={row.iso}>{row.time}</time>}
              status={
                <StatusDot
                  tone={row.squareTone}
                  label={row.squareTone === "idle" ? "info" : row.squareTone}
                />
              }
              event={<Link to={row.to}>{row.name}</Link>}
              subject={row.subject}
              detail={row.detail}
              {...(row.tone === undefined || row.tone === "ok" || row.tone === "idle"
                ? {}
                : { tone: row.tone })}
            />
          </li>
        );
      }}
    />
  );
}

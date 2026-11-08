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
  const note = [
    page.system,
    page.version,
    page.overview.read === undefined ? undefined : `read ${page.overview.read}`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <Page
      title={page.title}
      crumb={{ label: "Fleet", to: page.back }}
      status={<Pill tone={page.health.tone}>{page.health.word}</Pill>}
      {...(note === "" ? {} : { note })}
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
    ...(Array.isArray(host.capabilities)
      ? host.capabilities
          .filter((row) => row.state !== "available")
          .map((row) => ({
            label: row.name,
            value: (
              <>
                <Status tone={row.tone}>{row.state}</Status>
                {row.reason === undefined ? null : ` ${row.reason}`}
              </>
            ),
          }))
      : []),
    {
      label: "Worker id",
      value: <span className="mono worker-id">{host.id}</span>,
    },
  ];
  return (
    <aside className="worker-side" aria-label="Slots, host and baselines">
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
  return (
    <ul className="worker-devices" aria-label="Devices">
      {devices.map((device) => (
        <DeviceTile key={device.id} device={device} watch={page.streamTo(device.id)} />
      ))}
    </ul>
  );
}

function DeviceTile({ device, watch }: { readonly device: DeviceRow; readonly watch: string }) {
  const { holder } = device;
  const leased = holder !== undefined;
  return (
    <li className="worker-device">
      <div className="worker-device-top">
        <Link className="worker-device-name" to={device.to} title={device.model}>
          {device.model}
        </Link>
        <div className="worker-device-sub">
          <span className="mono" title={`${device.platform} ${device.runtime}`}>
            {device.platform} {device.runtime}
          </span>
          <Pill tone={device.status.tone} plain={device.status.word === "leased"}>
            {device.status.word}
          </Pill>
        </div>
      </div>
      {leased ? (
        <>
          <div className="worker-device-holder">
            <AgentChip kind={holder.kind} title={holder.name} />
            <Link className="mono" to={holder.to} title={holder.name}>
              {holder.display}
            </Link>
          </div>
          <div
            className="worker-device-ttl"
            title={device.expires === undefined ? undefined : `expires in ${device.expires}`}
          >
            <b className="mono">{device.ttl}</b>
            {device.ttlPercent === undefined ? null : (
              <Meter percent={device.ttlPercent} tone={device.ttlTone} size="thin" />
            )}
          </div>
        </>
      ) : (
        <>
          <p className="worker-device-idle">
            {device.status.word === "ready" ? "warm, waiting for a lease" : device.status.word}
          </p>
          <div className="worker-device-spacer" />
        </>
      )}
      <div className="worker-device-foot">
        <Link className="button button-secondary button-sm" to={watch}>
          Watch
        </Link>
        {device.timeNote === undefined ? null : <span>{device.timeNote}</span>}
      </div>
    </li>
  );
}

const WARM_COLUMNS: readonly Column<WarmRow>[] = [
  { cell: (target) => target.model, header: "Model" },
  { cell: (target) => target.runtime, header: "Runtime", mono: true },
  { cell: (target) => target.mode, header: "Mode" },
  { cell: (target) => target.origin, header: "Origin" },
  { cell: (target) => target.wanted, header: "Wanted", numeric: true },
  { cell: (target) => target.ready, header: "Ready", numeric: true },
  { cell: (target) => target.booting, header: "Booting", numeric: true },
  { cell: (target) => target.short, header: "Short", mono: true },
];

function WarmTab({ inspector }: { readonly inspector: WorkerPageView }) {
  const { warm } = inspector;
  if (warm === undefined) return null;
  return (
    <div className="worker-warm">
      <section>
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
              wide
            />
          </>
        )}
      </section>
      <section>
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

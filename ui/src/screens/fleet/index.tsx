import "./fleet.css";

import {
  Button,
  ButtonLink,
  ChoiceChips,
  type Column,
  DataTable,
  GroupHeader,
  Link,
  Loaded,
  type LoadView,
  LogRow,
  type MenuEntry,
  Meter,
  Page,
  type Paging,
  Pill,
  RowMenu,
  SearchField,
  Slots,
  Status,
  StatusDot,
} from "../../ds";
import {
  type FleetRow,
  type LogEventRow,
  type FleetPage,
  useFleet,
  useFleetAddress,
  useFleetEvents,
  useWorkerMenu,
  WORKER_FILTERS,
  type WorkerRow,
} from "../../state/workers";
import { StreamingPage, LegacyWatchRedirect } from "./streaming-page";
import { WorkerPageScreen } from "./worker-page";

export function FleetScreen() {
  const { deviceId, streaming, workerId } = useFleetAddress();
  if (workerId === undefined) return <FleetTable />;
  if (streaming === true && deviceId !== undefined) {
    return <StreamingPage workerId={workerId} deviceId={deviceId} />;
  }
  return (
    <>
      <LegacyWatchRedirect workerId={workerId} deviceId={deviceId} />
      <WorkerPageScreen id={workerId} deviceId={deviceId} />
    </>
  );
}

function FleetTable() {
  const view = useFleet();
  const log = useFleetEvents();
  return (
    <Page
      title="Fleet"
      actions={
        <ButtonLink variant="primary" to={ADD_WORKER_URL}>
          Add worker
        </ButtonLink>
      }
    >
      <Loaded view={view}>{(page) => <FleetBody page={page} log={log} />}</Loaded>
    </Page>
  );
}

const ADD_WORKER_URL = "https://callstackincubator.github.io/simlock/docs/gateway/joining-workers";

export function FleetBody({
  log,
  page,
}: {
  readonly page: FleetPage;
  readonly log: LoadView<{ readonly rows: readonly LogEventRow[] }>;
}) {
  const entries = useWorkerMenu();
  const none = page.attention.length === 0 && page.healthy.length === 0;
  return (
    <>
      <div className="fleet-controls">
        <ChoiceChips
          legend="Show workers"
          choices={WORKER_FILTERS}
          value={page.filter}
          onChange={page.setFilter}
        />
        <SearchField
          label="Search workers"
          placeholder="Filter workers"
          value={page.query}
          onChange={page.search}
        />
      </div>
      {none ? (
        <p className="muted">{page.empty ? "No workers have connected." : "No worker matches."}</p>
      ) : null}
      {page.attention.length === 0 ? null : (
        <section className="fleet-group" aria-label="Needs attention">
          <GroupHeader count={page.attention.length}>Needs attention</GroupHeader>
          <div className="fleet-cards fleet-cards-attention">
            {page.attention.map((row) => (
              <AttentionCard key={row.id} row={row} entries={entries(row)} />
            ))}
          </div>
        </section>
      )}
      {page.healthy.length === 0 ? null : (
        <section className="fleet-group" aria-label="Healthy">
          <GroupHeader count={page.healthy.length}>Healthy</GroupHeader>
          <div className="fleet-cards fleet-cards-healthy">
            {page.healthy.map((row) => (
              <HealthyTile key={row.id} row={row} entries={entries(row)} />
            ))}
          </div>
        </section>
      )}
      <Loaded view={log}>{(shown) => <FleetLog rows={shown.rows} />}</Loaded>
    </>
  );
}

function leasesWord(row: FleetRow): string | undefined {
  if (row.leaseCount === undefined) return undefined;
  return `${row.leaseCount} ${row.leaseCount === 1 ? "lease" : "leases"}`;
}

function osLine(row: FleetRow): string {
  return [row.system, row.version].filter((part) => part !== undefined).join(" · ");
}

function meterOf(row: FleetRow, label: string) {
  return row.meters.find((candidate) => candidate.label === label);
}

function Metric(props: { readonly row: FleetRow; readonly label: string; readonly short: string }) {
  const meter = meterOf(props.row, props.label);
  const percent = meter?.percent;
  return (
    <span className="fleet-metric">
      <span className="fleet-label">{props.short}</span>
      {percent === undefined ? (
        <span className="fleet-metric-empty" />
      ) : (
        <Meter percent={percent} tone={meter?.tone ?? "neutral"} size="thin" />
      )}
      <b>{percent === undefined ? "—" : `${percent}%`}</b>
    </span>
  );
}

function AttentionCard({
  entries,
  row,
}: {
  readonly row: FleetRow;
  readonly entries: readonly MenuEntry[];
}) {
  const undrain = entries.find((entry) => entry.key === "undrain");
  const leases = leasesWord(row);
  return (
    <article className={`fleet-card fleet-card-${row.health.tone}`}>
      <div className="fleet-card-head">
        <div className="fleet-card-title">
          <Link className="fleet-name" to={row.to} title={row.name}>
            {row.name}
          </Link>
          <span className="fleet-os">{osLine(row)}</span>
        </div>
        <Pill tone={row.health.tone}>{row.health.word}</Pill>
      </div>
      <p className="fleet-reason">{row.reason}</p>
      <div className="fleet-platforms">
        <span className="fleet-label fleet-platform">iOS</span>
        <Slots size="md" slots={row.ios} label={`iOS: ${row.iosLabel}`} />
        <span className="fleet-label fleet-platform fleet-platform-android">Android</span>
        <Slots size="md" slots={row.android} label={`Android: ${row.androidLabel}`} />
      </div>
      <div className="fleet-metrics">
        <Metric row={row} label="CPU" short="CPU" />
        <Metric row={row} label="Memory" short="MEM" />
        <Metric row={row} label="Disk" short="DISK" />
      </div>
      <div className="fleet-actions">
        {row.connection === "disconnected" ? (
          <ButtonLink small to="/leases">
            View leases
          </ButtonLink>
        ) : undrain === undefined ? (
          <ButtonLink small to={row.to}>
            Open
          </ButtonLink>
        ) : (
          <Button small disabled={undrain.disabled} onClick={undrain.onSelect}>
            {undrain.label}
          </Button>
        )}
        <ButtonLink small to={row.to}>
          Details
        </ButtonLink>
        {leases === undefined ? null : <span className="fleet-leases">{leases}</span>}
      </div>
    </article>
  );
}

function HealthyTile({
  entries,
  row,
}: {
  readonly row: FleetRow;
  readonly entries: readonly MenuEntry[];
}) {
  const leases = leasesWord(row);
  const combined = row.slots.length > 10;
  return (
    <article className="fleet-card fleet-tile">
      <div className="fleet-tile-head">
        <Link className="fleet-name" to={row.to} title={row.name}>
          {row.name}
        </Link>
        <span className="fleet-fraction">
          {row.slotsLeased} / {row.slots.length}
        </span>
      </div>
      <div className="fleet-tile-slots">
        {combined ? (
          <Slots size="md" slots={row.slots} label={row.slotsLabel} />
        ) : (
          <>
            {row.ios.length === 0 ? null : (
              <Slots size="md" slots={row.ios} label={`iOS: ${row.iosLabel}`} />
            )}
            {row.ios.length === 0 || row.android.length === 0 ? null : (
              <span className="fleet-divider" aria-hidden="true" />
            )}
            {row.android.length === 0 ? null : (
              <Slots size="md" slots={row.android} label={`Android: ${row.androidLabel}`} />
            )}
          </>
        )}
      </div>
      <div className="fleet-tile-metrics">
        <Metric row={row} label="CPU" short="CPU" />
        <Metric row={row} label="Memory" short="MEM" />
        <Metric row={row} label="Disk" short="DISK" />
      </div>
      <div className="fleet-tile-foot">
        {[leases, row.system].filter((part) => part !== undefined).join(" · ")}
        <RowMenu label={`Actions for ${row.name}`} entries={entries} />
      </div>
    </article>
  );
}

function FleetLog({ rows }: { readonly rows: readonly LogEventRow[] }) {
  return (
    <section className="fleet-log" aria-label="Worker events">
      <header className="fleet-log-head">
        <h2 className="fleet-label">Worker events</h2>
        <Pill tone="ok">live</Pill>
        <span className="fleet-log-count">last hour · {rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="muted fleet-log-empty">No worker events in the last hour.</p>
      ) : (
        <ul className="fleet-log-list" aria-label="Worker events">
          {rows.map((row) => (
            <li key={row.id}>
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
          ))}
        </ul>
      )}
    </section>
  );
}

// why: the Overview draws this same table, every worker and no pager, so it passes no `paging`.
export function WorkersTable(props: {
  readonly rows: readonly WorkerRow[];
  readonly empty: string;
  readonly paging?: Paging;
}) {
  const entries = useWorkerMenu();
  return (
    <DataTable
      label="Workers"
      rows={props.rows}
      columns={COLUMNS}
      rowId={(row) => row.id}
      rowTo={(row) => row.to}
      menu={{ entries, label: (row) => `Actions for ${row.name}` }}
      empty={props.empty}
      {...(props.paging === undefined ? {} : { paging: props.paging })}
      wide
    />
  );
}

function MeterCell({ label, row }: { readonly label: string; readonly row: WorkerRow }) {
  const meter = row.meters.find((candidate) => candidate.label === label);
  if (meter?.percent === undefined) return <>—</>;
  return (
    <span className="worker-meter">
      <span className="mono">{meter.percent}%</span>
      <Meter percent={meter.percent} tone={meter.tone} size="thin" />
    </span>
  );
}

const COLUMNS: readonly Column<WorkerRow>[] = [
  {
    cell: (row) => (
      <span className="worker-name">
        <Link to={row.to} title={row.name}>
          {row.name}
        </Link>
        {row.system === undefined && row.version === undefined ? null : (
          <span className="worker-system">
            {[row.system, row.version].filter((part) => part !== undefined).join(" · ")}
          </span>
        )}
      </span>
    ),
    header: "Worker",
  },
  {
    cell: (row) => (
      <span className="worker-name">
        <Status tone={row.health.tone}>{row.health.word}</Status>
        {row.stage === undefined ? null : <span className="worker-system">{row.stage}</span>}
      </span>
    ),
    header: "State",
  },
  { cell: (row) => <Slots slots={row.slots} label={row.slotsLabel} />, header: "Slots" },
  {
    cell: (row) => (row.use === undefined ? "—" : `${row.use.running} / ${row.use.limit}`),
    header: "Use",
    mono: true,
  },
  { cell: (row) => <MeterCell label="CPU" row={row} />, header: "CPU" },
  { cell: (row) => <MeterCell label="Memory" row={row} />, header: "Memory" },
  { cell: (row) => <MeterCell label="Disk" row={row} />, header: "Disk" },
];

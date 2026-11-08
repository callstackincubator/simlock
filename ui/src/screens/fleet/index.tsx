import "./fleet.css";

import {
  ButtonLink,
  ChoiceChips,
  type Column,
  DataTable,
  Hint,
  Link,
  Loaded,
  type LoadView,
  LogRow,
  type MenuEntry,
  Meter,
  Page,
  Pill,
  RowMenu,
  SearchField,
  Slots,
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
  const rows = [...page.attention, ...page.healthy];
  const attention = new Set(page.attention.map((row) => row.id));
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
      {none ? null : <FleetList groups={groups(page)} entries={entries} />}
      {none ? null : (
        <div className="fleet-wide">
          <DataTable
            label="Workers"
            rows={rows}
            columns={columnsOf()}
            rowId={(row) => row.id}
            empty="No workers."
            menu={{
              entries: (row) => entries(row),
              label: (row) => `Actions for ${row.name}`,
            }}
            groupBy={(row) =>
              attention.has(row.id)
                ? { id: "attention", label: `Needs attention ${page.attention.length}` }
                : { id: "healthy", label: `Healthy ${page.healthy.length}` }
            }
            rowClassName={(row) =>
              attention.has(row.id)
                ? `row-${row.health.tone === "error" ? "error" : "warn"}`
                : undefined
            }
            className="fleet-table table-lines"
            footer="count"
            wide
          />
        </div>
      )}
      <Loaded view={log}>{(shown) => <FleetLog rows={shown.rows} />}</Loaded>
    </>
  );
}

function groups(page: FleetPage) {
  return [
    { id: "attention", label: `Needs attention ${page.attention.length}`, rows: page.attention },
    { id: "healthy", label: `Healthy ${page.healthy.length}`, rows: page.healthy },
  ].filter((group) => group.rows.length > 0);
}

// why: under 1100px a worker is a list row, not a table row: name and pill, one muted line of
// figures, and its menu. The sheet shows this list there and the table above it.
function FleetList(props: {
  readonly groups: ReturnType<typeof groups>;
  readonly entries: (row: FleetRow) => readonly MenuEntry[];
}) {
  return (
    <div className="fleet-list" role="list" aria-label="Workers">
      {props.groups.map((group) => (
        <div key={group.id} role="presentation">
          <p className="fleet-list-group">{group.label}</p>
          {group.rows.map((row) => (
            <div
              key={row.id}
              role="listitem"
              className={`fleet-item${
                group.id === "attention"
                  ? ` row-${row.health.tone === "error" ? "error" : "warn"}`
                  : ""
              }`}
            >
              <div className="fleet-item-main">
                <p className="fleet-item-head">
                  <Link className="fleet-name" to={row.to} title={row.name}>
                    {row.name}
                  </Link>
                  <StatePill row={row} />
                </p>
                <p className="fleet-item-line" title={row.summary}>
                  {row.summary}
                </p>
              </div>
              <RowMenu label={`Actions for ${row.name}`} entries={props.entries(row)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function osLine(row: FleetRow): string {
  return [row.system, row.version].filter((part) => part !== undefined).join(" · ");
}

function meterOf(row: FleetRow, label: string) {
  return row.meters.find((candidate) => candidate.label === label);
}

function Metric(props: { readonly row: FleetRow; readonly label: string }) {
  const meter = meterOf(props.row, props.label);
  const percent = meter?.percent;
  return (
    <span className="fleet-metric">
      {percent === undefined ? (
        <span className="fleet-metric-empty" />
      ) : (
        <Meter percent={percent} tone={meter?.tone ?? "neutral"} size="thin" />
      )}
      <b>{percent === undefined ? "—" : `${percent}%`}</b>
    </span>
  );
}

function metricColumn(header: string, label: string, drop: number): Column<FleetRow> {
  return {
    cell: (row) => <Metric row={row} label={label} />,
    drop,
    header,
    width: "96px",
  };
}

// why: the reason a worker is not healthy is a line too long for the cell; it shows on hover and on
// keyboard focus of the pill.
function StatePill({ row }: { readonly row: FleetRow }) {
  return (
    <Hint text={row.health.tone === "ok" ? "" : row.reason}>
      <Pill tone={row.health.tone}>{row.health.word}</Pill>
    </Hint>
  );
}

function columnsOf(): readonly Column<FleetRow>[] {
  return [
    {
      cell: (row) => (
        <>
          <Link className="fleet-name cell-line" to={row.to} title={row.name}>
            {row.name}
          </Link>
          <span className="cell-line" title={osLine(row)}>
            {osLine(row)}
          </span>
        </>
      ),
      header: "Worker",
    },
    {
      cell: (row) => <StatePill row={row} />,
      header: "State",
      width: "140px",
    },
    {
      cell: (row) =>
        row.slots.length === 0 ? null : <Slots slots={row.slots} label={row.slotsLabel} />,
      drop: 5,
      header: "Slots",
      width: "120px",
    },
    metricColumn("CPU", "CPU", 4),
    metricColumn("Mem", "Memory", 2),
    metricColumn("Disk", "Disk", 3),
    {
      cell: (row) => (row.leaseCount === undefined ? "—" : String(row.leaseCount)),
      drop: 1,
      header: "Leases",
      numeric: true,
      width: "64px",
    },
  ];
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

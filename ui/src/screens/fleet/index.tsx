import "./fleet.css";

import {
  ChoiceChips,
  type Column,
  DataTable,
  Link,
  Loaded,
  Meter,
  Page,
  type Paging,
  SearchField,
  Slots,
  Status,
  Toolbar,
} from "../../ds";
import {
  type FleetPage,
  useFleet,
  useWorkerMenu,
  useFleetAddress,
  WORKER_FILTERS,
  type WorkerRow,
} from "../../state/workers";
import { WorkerPageScreen } from "./worker-page";

export function FleetScreen() {
  const { deviceId, workerId } = useFleetAddress();
  return workerId === undefined ? (
    <FleetTable />
  ) : (
    <WorkerPageScreen id={workerId} deviceId={deviceId} />
  );
}

function FleetTable() {
  const view = useFleet();
  return (
    <Page
      title="Fleet"
      actions={view.kind === "ready" ? <span className="muted">{view.data.meta}</span> : null}
    >
      <Loaded view={view}>{(page) => <FleetBody page={page} />}</Loaded>
    </Page>
  );
}

export function FleetBody({ page }: { readonly page: FleetPage }) {
  return (
    <>
      <Toolbar
        start={
          <ChoiceChips
            legend="Show workers"
            choices={WORKER_FILTERS}
            value={page.filter}
            onChange={page.setFilter}
          />
        }
        end={<SearchField label="Search workers" value={page.query} onChange={page.search} />}
      />
      <WorkersTable
        rows={page.rows}
        empty={page.empty ? "No workers have connected." : "No worker matches."}
        paging={page.paging}
      />
    </>
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
        {row.system === undefined ? null : <span className="worker-system">{row.system}</span>}
      </span>
    ),
    header: "Worker",
  },
  {
    cell: (row) => <Status tone={row.health.tone}>{row.health.word}</Status>,
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

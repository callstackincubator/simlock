import "./fleet.css";

import {
  ChoiceChips,
  type Column,
  DataTable,
  Link,
  Loaded,
  Meter,
  Page,
  SearchField,
  Slots,
  Status,
  Toolbar,
} from "../../ds";
import {
  type FleetPage,
  useFleet,
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
      <DataTable
        label="Workers"
        rows={page.rows}
        columns={COLUMNS}
        rowId={(row) => row.id}
        rowTo={(row) => row.to}
        empty={page.empty ? "No workers have connected." : "No worker matches."}
        paging={page.paging}
        wide
      />
    </>
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
        <Link to={row.to}>{row.name}</Link>
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

import "./fleet.css";

import { ChoiceChips, type Column, DataTable, Link, Loaded, Page, Toolbar } from "../../ds";
import {
  type FleetPage,
  useFleet,
  useFleetAddress,
  WORKER_FILTERS,
  type WorkerRow,
} from "../../state/workers";
import { WorkerPageScreen } from "./worker-page";

export function FleetScreen() {
  const { workerId } = useFleetAddress();
  return workerId === undefined ? <FleetTable /> : <WorkerPageScreen id={workerId} />;
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
      />
      <DataTable
        label="Workers"
        rows={page.rows}
        columns={COLUMNS}
        rowId={(row) => row.id}
        rowTo={(row) => row.to}
        empty={page.empty ? "No workers have connected." : "No worker matches."}
        paging={page.paging}
      />
    </>
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
];

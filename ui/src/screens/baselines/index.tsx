import { type Column, DataTable, Loaded, Page, Status } from "../../ds";
import { type BaselineRow, useBaselines } from "../../state/baselines";

const WORKER: Column<BaselineRow> = { cell: (row) => row.worker, header: "Worker" };

const COLUMNS: readonly Column<BaselineRow>[] = [
  { cell: (row) => row.name, header: "Name", mono: true },
  { cell: (row) => row.version, header: "Version", mono: true, numeric: true },
  { cell: (row) => row.platform, header: "Platform" },
  { cell: (row) => row.model, header: "Model" },
  { cell: (row) => row.os, header: "OS", mono: true },
  { cell: (row) => row.mode, header: "Mode" },
  { cell: (row) => row.note, header: "Note" },
  { cell: (row) => row.size, header: "Size", mono: true, numeric: true },
  {
    cell: (row) => <span title={row.savedAt}>{row.saved}</span>,
    header: "Saved",
    mono: true,
  },
  {
    cell: (row) =>
      row.stale === undefined ? null : (
        <>
          <Status tone="warn">stale</Status>
          {` · ${row.stale}`}
        </>
      ),
    header: "Stale",
  },
];

export function BaselinesScreen() {
  const view = useBaselines();
  return (
    <Page title="Baselines">
      <Loaded view={view}>
        {(page) => (
          <DataTable
            label="Baselines"
            rows={page.rows}
            columns={page.gateway ? [WORKER, ...COLUMNS] : COLUMNS}
            rowId={(row) => row.key}
            empty="No baselines."
            paging={page.paging}
          />
        )}
      </Loaded>
    </Page>
  );
}

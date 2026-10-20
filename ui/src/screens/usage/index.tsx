import "./usage.css";

import {
  ChoiceChips,
  type Column,
  DataTable,
  type Paging,
  Page,
  Panel,
  Refusal,
  StatRow,
  StatTile,
} from "../../ds";
import { type ConsoleRange, RANGE_CHOICES } from "../../state/range";
import {
  type UsageCount,
  type UsageDuration,
  type UsageLine,
  type UsageRequesterRow,
  type UsageScopeRow,
  type UsageState,
  type UsageView,
  useUsage,
  useUsagePaging,
  useUsageRange,
  wholePage,
} from "../../state/usage";

export function UsageScreen() {
  const [range, setRange] = useUsageRange();
  const state = useUsage(range);
  const paging = useUsagePaging(state);
  return (
    <Page title="Usage">
      <UsageBody state={state} range={range} onRange={setRange} paging={paging} />
    </Page>
  );
}

// why: the space after a count keeps one row's count and the next row's label apart in the table's
// text, which is how a screen reader's text view and a text search read it.
const COUNT_COLUMNS = (header: string): readonly Column<UsageCount>[] => [
  { cell: (row) => row.label, header, mono: true },
  { cell: (row) => `${row.count} `, header: "Count", numeric: true },
];

function Counts(props: {
  readonly title: string;
  readonly header: string;
  readonly rows: readonly UsageCount[];
  readonly empty: string;
}) {
  const { empty, header, rows, title } = props;
  return (
    <Panel title={title}>
      <DataTable
        label={title}
        rows={rows}
        columns={COUNT_COLUMNS(header)}
        rowId={(row) => row.label}
        empty={empty}
        paging={wholePage(rows.length)}
      />
    </Panel>
  );
}

const DURATION_COLUMNS: readonly Column<UsageDuration>[] = [
  { cell: (row) => row.name, header: "Duration" },
  { cell: (row) => row.count, header: "Count", numeric: true },
  { cell: (row) => row.p50, header: "p50", numeric: true },
  { cell: (row) => row.p95, header: "p95", numeric: true },
  { cell: (row) => row.max, header: "Max", numeric: true },
];

const USE_COLUMNS: readonly Column<UsageLine>[] = [
  { cell: (row) => row.label, header: "Measure" },
  { cell: (row) => row.text, header: "Figures", mono: true },
];

function scopeColumns(first: string): readonly Column<UsageScopeRow>[] {
  return [
    { cell: (row) => row.name, header: first },
    { cell: (row) => row.requests, header: "Requests", numeric: true },
    { cell: (row) => row.granted, header: "Granted", numeric: true },
    { cell: (row) => row.rejected, header: "Rejected", numeric: true },
    { cell: (row) => row.waitP95, header: "Wait p95", numeric: true },
  ];
}

const REQUESTER_COLUMNS: readonly Column<UsageRequesterRow>[] = [
  {
    cell: (row) =>
      row.label === undefined ? (
        <span className="mono">{row.id}</span>
      ) : (
        <>
          {row.label} <span className="mono muted usage-id">{row.id}</span>
        </>
      ),
    header: "Requester",
  },
  { cell: (row) => row.requests, header: "Requests", numeric: true },
  { cell: (row) => row.granted, header: "Granted", numeric: true },
  { cell: (row) => row.rejected, header: "Rejected", numeric: true },
  { cell: (row) => row.held, header: "Held in total", numeric: true },
];

export function UsageBody(props: {
  readonly state: UsageState;
  readonly range: ConsoleRange;
  readonly onRange: (range: ConsoleRange) => void;
  readonly paging: { readonly workers: Paging; readonly requesters: Paging };
}) {
  const { onRange, paging, range, state } = props;
  const ready = state.kind === "ready" ? state : undefined;
  return (
    <>
      <div className="usage-range">
        <ChoiceChips legend="Range" choices={RANGE_CHOICES} value={range} onChange={onRange} />
        {ready?.data.note === undefined ? null : <p className="muted">{ready.data.note}</p>}
      </div>
      {state.kind === "loading" ? <p className="muted loaded-note">Loading…</p> : null}
      {state.kind === "refused" ? <Refusal message={state.message} /> : null}
      {ready === undefined ? null : (
        <>
          {ready.refusal === undefined ? null : <Refusal message={ready.refusal} />}
          <Figures view={ready.data} paging={paging} />
        </>
      )}
    </>
  );
}

function Figures(props: {
  readonly view: UsageView;
  readonly paging: { readonly workers: Paging; readonly requesters: Paging };
}) {
  const { paging, view } = props;
  return (
    <>
      <StatRow label="Usage figures">
        {view.tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </StatRow>
      <div className="usage-stack">
        <div className="usage-panels">
          <Counts
            title="Grants by source"
            header="Source"
            rows={view.bySource}
            empty="No grants in this range."
          />
          <Panel title="Durations">
            <DataTable
              label="Durations"
              rows={view.durations}
              columns={DURATION_COLUMNS}
              rowId={(row) => row.name}
              empty="No durations."
              paging={wholePage(view.durations.length)}
              wide
            />
          </Panel>
          <Counts
            title="Rejections by reason"
            header="Reason"
            rows={view.rejections}
            empty="No requests were rejected."
          />
          <Panel title="Use over the range">
            <DataTable
              label="Use over the range"
              rows={view.use}
              columns={USE_COLUMNS}
              rowId={(row) => row.label}
              empty="No figures."
              paging={wholePage(view.use.length)}
            />
          </Panel>
          <Counts
            title="Device incidents"
            header="Incident"
            rows={view.incidents}
            empty="No incidents."
          />
        </div>
        <Panel title="Per platform">
          <DataTable
            label="Per platform"
            rows={view.platforms}
            columns={scopeColumns("Platform")}
            rowId={(row) => row.key}
            empty="No platforms."
            paging={wholePage(view.platforms.length)}
          />
        </Panel>
        <Panel title="Per worker">
          <DataTable
            label="Per worker"
            rows={view.workers}
            columns={scopeColumns("Worker")}
            rowId={(row) => row.key}
            empty="No workers in this range."
            paging={paging.workers}
          />
        </Panel>
        <Panel title="Per requester">
          <DataTable
            label="Per requester"
            rows={view.requesters}
            columns={REQUESTER_COLUMNS}
            rowId={(row) => row.key}
            empty="No requests in this range."
            paging={paging.requesters}
          />
        </Panel>
      </div>
    </>
  );
}

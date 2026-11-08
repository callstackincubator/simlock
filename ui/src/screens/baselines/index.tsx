import "./baselines.css";

import {
  ButtonLink,
  ChoiceChips,
  type Column,
  DataTable,
  Icon,
  Loaded,
  Page,
  Pill,
  SearchField,
  Hint,
} from "../../ds";
import { BASELINE_FILTERS, type BaselineRow, useBaselines } from "../../state/baselines";

const PREPARE = "https://callstackincubator.github.io/simlock/docs/worker/baselines";

const COLUMNS: readonly Column<BaselineRow>[] = [
  {
    cell: (row) => (
      <span className="baseline-who">
        <span className="baseline-icon">
          <Icon name="baselines" />
        </span>
        <span className="baseline-text">
          <b className="baseline-name" title={row.name}>
            {row.name}
          </b>
          <small className="baseline-detail" title={row.detail}>
            {row.detail}
          </small>
        </span>
      </span>
    ),
    header: "Baseline",
  },
  {
    cell: (row) => row.size,
    className: "baseline-size",
    drop: 3,
    fit: 90,
    header: "Size",
    mono: true,
  },
  {
    cell: (row) => (
      <span className="baseline-worker" title={row.worker}>
        {row.worker ?? "—"}
      </span>
    ),
    className: "baseline-worker-col",
    drop: 2,
    fit: 160,
    header: "Worker",
    mono: true,
  },
  { cell: (row) => row.built, className: "baseline-built", drop: 1, fit: 110, header: "Built" },
  {
    cell: (row) => (
      <span className="baseline-state">
        <Hint text={row.staleReason ?? ""}>
          <Pill tone={row.state === "ready" ? "ok" : "warn"}>{row.state}</Pill>
        </Hint>
      </span>
    ),
    className: "baseline-state-col",
    fit: 110,
    header: "State",
  },
  { cell: () => null, className: "baseline-menu", fit: 48, header: "Actions", hideHeader: true },
];

export function BaselinesScreen() {
  const { choose, filter, query, search, view } = useBaselines();
  return (
    <Page
      title="Baselines"
      actions={
        <ButtonLink to={PREPARE} variant="primary">
          Prepare baseline
        </ButtonLink>
      }
    >
      <div className="baseline-filters">
        <ChoiceChips
          legend="Filter baselines"
          choices={BASELINE_FILTERS}
          value={filter}
          onChange={choose}
        />
        <SearchField
          label="Search baselines"
          placeholder="Filter baselines"
          value={query}
          onChange={search}
        />
      </div>
      <Loaded view={view}>
        {(page) => (
          <>
            <DataTable
              label="Baselines"
              rows={page.rows}
              columns={page.gateway ? COLUMNS : COLUMNS.filter((c) => c.header !== "Worker")}
              rowId={(row) => row.key}
              groupBy={page.group}
              empty={page.narrowed ? "No baselines match this filter or search." : "No baselines."}
              paging={page.paging}
              className="baselines-table"
            />
          </>
        )}
      </Loaded>
    </Page>
  );
}

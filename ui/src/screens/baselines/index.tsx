import "./baselines.css";

import {
  ButtonLink,
  ChoiceChips,
  type Column,
  DataTable,
  Icon,
  Loaded,
  Meter,
  Page,
  Panel,
  Pill,
  SearchField,
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
  { cell: (row) => row.size, className: "baseline-size", header: "Size", mono: true },
  {
    cell: (row) => (
      <span className="baseline-worker" title={row.worker}>
        {row.worker ?? "—"}
      </span>
    ),
    className: "baseline-worker-col",
    header: "Worker",
    mono: true,
  },
  { cell: (row) => row.built, className: "baseline-built", header: "Built" },
  {
    cell: (row) => (
      <span className="baseline-state">
        <Pill tone={row.state === "ready" ? "ok" : "warn"}>{row.state}</Pill>
        {row.staleReason === undefined ? null : (
          <span className="baseline-reason" title={row.staleReason}>
            {row.staleReason}
          </span>
        )}
      </span>
    ),
    className: "baseline-state-col",
    header: "State",
  },
  { cell: () => null, className: "baseline-menu", header: "Actions", hideHeader: true },
];

export function BaselinesScreen() {
  const { choose, filter, query, search, view } = useBaselines();
  return (
    <Page
      title="Baselines"
      {...(view.kind === "ready" && view.data.summary !== "" ? { note: view.data.summary } : {})}
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
            {page.disk.shares.length === 0 ? null : (
              <Panel
                title="Disk used by baselines"
                actions={
                  <span className="baseline-disk-note">
                    {page.disk.summary} · share of each disk
                  </span>
                }
                className="baselines-disk"
              >
                <ul className="baseline-disk">
                  {page.disk.shares.map((share) => (
                    <li key={share.key}>
                      <span className="baseline-disk-name" title={share.name}>
                        {share.name}
                      </span>
                      <Meter percent={share.percent ?? 0} tone="neutral" size="thin" />
                      <span className="baseline-disk-text">{share.text}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </>
        )}
      </Loaded>
    </Page>
  );
}

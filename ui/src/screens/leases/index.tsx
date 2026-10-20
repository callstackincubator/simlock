import "./leases.css";

import {
  ChoiceChips,
  type Column,
  DataTable,
  Link,
  Loaded,
  Meter,
  Page,
  type Paging,
  Toolbar,
} from "../../ds";
import { navigate, useSearch } from "../../state/router";
import { LEASE_FILTERS, type LeaseFilter, type LeaseRowView, useLeases } from "../../state/leases";
import { LeaseDrawer } from "./drawer";

export function LeasesScreen() {
  const { choose, filter, paging, urlId, view } = useLeases();
  const search = useSearch();
  return (
    <Page
      title="Leases"
      actions={view.kind === "ready" ? <span className="muted">{view.data.held} held</span> : null}
    >
      <Toolbar
        start={
          <ChoiceChips
            legend="Filter leases"
            choices={LEASE_FILTERS}
            value={filter}
            onChange={choose}
          />
        }
      />
      <Loaded view={view}>
        {(page) => <LeaseTable rows={page.rows} filter={filter} paging={paging} />}
      </Loaded>
      {urlId === undefined ? null : (
        <LeaseDrawer key={urlId} id={urlId} onClose={() => navigate(`/leases${search}`)} />
      )}
    </Page>
  );
}

const COLUMNS: readonly Column<LeaseRowView>[] = [
  {
    cell: (row) => <Link to={row.to}>{row.holder}</Link>,
    header: "Holder",
    mono: true,
  },
  { cell: (row) => row.sub, header: "Device" },
  {
    cell: (row) => (
      <>
        <span className={row.expiring ? "lease-warn" : undefined}>
          {row.expiring ? <span className="visually-hidden">expiring, </span> : null}
          {row.remaining}
        </span>
        <span className="lease-meter">
          <Meter percent={row.percent} tone={row.expiring ? "warn" : "neutral"} size="thin" />
        </span>
      </>
    ),
    header: "Expires in",
  },
];

export function LeaseTable(props: {
  readonly rows: readonly LeaseRowView[];
  readonly filter: LeaseFilter;
  readonly paging: Paging;
}) {
  const { filter, paging, rows } = props;
  return (
    <DataTable
      label="Leases"
      rows={rows}
      columns={COLUMNS}
      rowId={(row) => row.key}
      rowTo={(row) => row.to}
      empty={filter === "all" ? "No leases." : "No leases match this filter."}
      paging={paging}
    />
  );
}

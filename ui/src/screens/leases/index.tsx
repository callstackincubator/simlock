import "./leases.css";

import {
  ChoiceChips,
  type Column,
  focusAfterClosing,
  DataTable,
  Link,
  Loaded,
  Meter,
  Page,
  type Paging,
  SearchField,
  Toolbar,
} from "../../ds";
import {
  LEASE_FILTERS,
  type LeaseRowView,
  useLeaseDrawer,
  useLeaseMenu,
  useLeases,
} from "../../state/leases";
import { LeaseDrawer } from "./drawer";

export function LeasesScreen() {
  const { choose, filter, paging, query, search: setQuery, urlId, view } = useLeases();
  const { close, fromList } = useLeaseDrawer(urlId);
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
        end={<SearchField label="Search leases" value={query} onChange={setQuery} />}
      />
      <Loaded view={view}>
        {(page) => (
          <LeaseTable
            rows={page.rows}
            narrowed={filter !== "all" || query !== ""}
            paging={paging}
          />
        )}
      </Loaded>
      {urlId === undefined ? null : (
        <LeaseDrawer
          key={urlId}
          id={urlId}
          onClose={close}
          finalFocus={() =>
            focusAfterClosing({
              fromList,
              links: "main tbody a",
              path: `/leases/${encodeURIComponent(urlId)}`,
            })
          }
        />
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
  readonly narrowed: boolean;
  readonly paging: Paging;
}) {
  const { narrowed, paging, rows } = props;
  const entries = useLeaseMenu();
  return (
    <DataTable
      label="Leases"
      rows={rows}
      columns={COLUMNS}
      rowId={(row) => row.key}
      rowTo={(row) => row.to}
      menu={{ entries, label: (row) => `Actions for ${row.holder}` }}
      empty={narrowed ? "No leases match this filter or search." : "No leases."}
      paging={paging}
    />
  );
}

import "./leases.css";

import {
  AgentChip,
  ChoiceChips,
  type Column,
  DataTable,
  focusAfterClosing,
  Link,
  Loaded,
  Meter,
  Page,
  type Paging,
  SearchField,
} from "../../ds";
import {
  LEASE_FILTERS,
  type LeaseRowView,
  useLeaseDrawer,
  useLeases,
  useWideLayout,
} from "../../state/leases";
import { LeaseInspector } from "./inspector";
import { LeaseSummaryPane } from "./summary";

export function LeasesScreen() {
  const { choose, filter, paging, query, search, selectedKey, summary, urlId, view } = useLeases();
  const { close, fromList } = useLeaseDrawer(urlId);
  const wide = useWideLayout();
  const finalFocus = () =>
    focusAfterClosing({
      fromList,
      links: "main tbody a",
      path: `/leases/${encodeURIComponent(urlId ?? "")}`,
    });
  const closePane = () => {
    close();
    // why: the pane stays mounted beside the table, so focus is sent back to the lease's row here.
    window.setTimeout(() => finalFocus()?.focus(), 0);
  };
  const open = urlId !== undefined;
  const summaryPane = summary === undefined ? null : <LeaseSummaryPane summary={summary} />;
  return (
    <Page title="Leases">
      <div className="lease-tools">
        <ChoiceChips
          legend="Filter leases"
          choices={LEASE_FILTERS}
          value={filter}
          onChange={choose}
        />
        <SearchField
          label="Search leases"
          placeholder="Filter by holder, device, worker"
          className="lease-search"
          value={query}
          onChange={search}
        />
      </div>
      <div className="lease-layout">
        <div className="lease-main">
          <Loaded view={view}>
            {(page) => (
              <LeaseTable
                rows={page.rows}
                narrowed={filter !== "all" || query !== ""}
                paging={paging}
                selectedId={selectedKey}
              />
            )}
          </Loaded>
        </div>
        {wide ? (
          <aside className="lease-aside">
            {open ? <LeaseInspector key={urlId} id={urlId} onClose={closePane} /> : summaryPane}
          </aside>
        ) : (
          <>
            {open ? null : <aside className="lease-aside">{summaryPane}</aside>}
            {open ? (
              <LeaseInspector key={urlId} id={urlId} onClose={close} drawer={{ finalFocus }} />
            ) : null}
          </>
        )}
      </div>
    </Page>
  );
}

const COLUMNS: readonly Column<LeaseRowView>[] = [
  {
    cell: (row) => (
      <span className="lease-holder">
        <AgentChip kind={row.holderKind} />
        <Link to={row.to} title={row.holderTitle}>
          {row.holderDisplay}
        </Link>
      </span>
    ),
    header: "Held by",
    mono: true,
  },
  {
    cell: (row) => (
      <span className="lease-device" title={row.sub}>
        <b>{row.model}</b>
        {row.runtime === undefined ? null : <small className="mono">{row.runtime}</small>}
      </span>
    ),
    drop: 2,
    header: "Device",
    width: "170px",
  },
  {
    cell: (row) => (
      <span className="lease-worker" title={row.worker}>
        {row.worker ?? "—"}
      </span>
    ),
    drop: 1,
    header: "Worker",
    mono: true,
    width: "150px",
  },
  {
    cell: (row) => (
      <span className="lease-ttl">
        <span className={row.expiring ? "mono lease-warn" : "mono"}>
          {row.expiring ? <span className="visually-hidden">expiring, </span> : null}
          {row.remaining}
        </span>
        <Meter percent={row.percent} tone={row.expiring ? "warn" : "neutral"} size="thin" />
      </span>
    ),
    header: "Expires in",
    width: "132px",
  },
];

export function LeaseTable(props: {
  readonly rows: readonly LeaseRowView[];
  readonly narrowed: boolean;
  readonly paging: Paging;
  readonly selectedId?: string | undefined;
}) {
  const { narrowed, paging, rows, selectedId } = props;
  return (
    <DataTable
      label="Leases"
      rows={rows}
      columns={COLUMNS}
      rowId={(row) => row.key}
      rowTo={(row) => row.to}
      selectedId={selectedId}
      // why: the footer is the count alone while every lease fits on a page; a longer list needs its pager.
      footer={paging.total > paging.size ? "pager" : "count"}
      empty={narrowed ? "No leases match this filter or search." : "No leases."}
      paging={paging}
    />
  );
}

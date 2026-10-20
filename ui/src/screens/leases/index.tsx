import "./leases.css";

import { useRef } from "react";

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
  Toolbar,
} from "../../ds";
import { navigate, useSearch } from "../../state/router";
import { LEASE_FILTERS, type LeaseFilter, type LeaseRowView, useLeases } from "../../state/leases";
import { LeaseDrawer } from "./drawer";

export function LeasesScreen() {
  const { choose, filter, paging, query, search: setQuery, urlId, view } = useLeases();
  const address = useSearch();
  const fromList = useOpenedFromList(urlId);
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
        {(page) => <LeaseTable rows={page.rows} filter={filter} paging={paging} />}
      </Loaded>
      {urlId === undefined ? null : (
        <LeaseDrawer
          key={urlId}
          id={urlId}
          onClose={() => closeDrawer(fromList, `/leases${address}`)}
          finalFocus={() => focusAfterClosing(fromList, urlId)}
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

// why: the screen stays mounted from the list to a lease, so a lease that appears while it is
// mounted was opened from the list in this tab, and one present at the first render was loaded
// directly.
function useOpenedFromList(urlId: string | undefined): boolean {
  const mountedOpen = useRef(urlId !== undefined);
  if (urlId === undefined) mountedOpen.current = false;
  return !mountedOpen.current;
}

// why: closing a drawer opened from the list is a step back, so Back does not reopen it; one loaded
// directly has no list entry behind it, so closing replaces its address.
function closeDrawer(fromList: boolean, list: string): void {
  if (fromList) window.history.back();
  else navigate(list, { replace: true });
}

// why: focus goes back to the row that opened the drawer, or to the page's heading when that row is
// gone or the drawer was loaded directly.
function focusAfterClosing(fromList: boolean, id: string): HTMLElement | null {
  const prefix = `/leases/${encodeURIComponent(id)}/`;
  const row = fromList
    ? [...document.querySelectorAll<HTMLElement>("main tbody a")].find((link) =>
        link.getAttribute("href")?.startsWith(prefix),
      )
    : undefined;
  return row ?? document.querySelector<HTMLElement>("main h1");
}

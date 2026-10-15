import "./leases.css";

import {
  ChoiceChips,
  Empty,
  InspectorEmpty,
  List,
  ListPane,
  ListRow,
  Loaded,
  MasterDetail,
  Meter,
  Pager,
} from "../../ds";
import { LEASE_FILTERS, type LeaseFilter, type LeaseRowView, useLeases } from "../../state/leases";
import { LeaseInspector } from "./inspector";

export function LeasesScreen() {
  const { choose, filter, paging, urlId, view } = useLeases();
  const chosen = view.kind === "ready" ? view.data.chosen : urlId;
  return (
    <MasterDetail
      focus={urlId === undefined ? "list" : "detail"}
      list={
        <ListPane
          title="Leases"
          meta={view.kind === "ready" ? `${view.data.held} held` : undefined}
          toolbar={
            <ChoiceChips
              legend="Filter leases"
              choices={LEASE_FILTERS}
              value={filter}
              onChange={choose}
            />
          }
          footer={<Pager label="Leases" paging={paging} />}
        >
          <Loaded view={view}>
            {(page) => <LeaseRows rows={page.rows} chosen={page.chosen} filter={filter} />}
          </Loaded>
        </ListPane>
      }
      detail={
        chosen === undefined ? (
          <InspectorEmpty>
            {view.kind === "ready" ? "No leases." : "Select a lease."}
          </InspectorEmpty>
        ) : (
          <LeaseInspector key={chosen} id={chosen} />
        )
      }
    />
  );
}

export function LeaseRows(props: {
  readonly rows: readonly LeaseRowView[];
  readonly chosen: string | undefined;
  readonly filter: LeaseFilter;
}) {
  const { chosen, filter, rows } = props;
  if (rows.length === 0) {
    return <Empty>{filter === "all" ? "No leases." : "No leases match this filter."}</Empty>;
  }
  return (
    <List label="Leases">
      {rows.map((row) => (
        <ListRow
          key={row.key}
          to={row.to}
          selected={row.id === chosen}
          mono
          title={row.holder}
          aside={
            <span className={row.expiring ? "lease-warn" : undefined}>
              {row.expiring ? <span className="visually-hidden">expiring, </span> : null}
              {row.remaining}
            </span>
          }
          sub={row.sub}
          trail={
            <span className="lease-meter">
              <Meter percent={row.percent} tone={row.expiring ? "warn" : "neutral"} size="thin" />
            </span>
          }
        />
      ))}
    </List>
  );
}

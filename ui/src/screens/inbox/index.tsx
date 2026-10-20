import "./inbox.css";

import {
  ButtonLink,
  Card,
  Empty,
  Grid,
  Inspector,
  InspectorEmpty,
  Link,
  List,
  ListPane,
  ListRow,
  Loaded,
  MasterDetail,
  Pager,
  Panel,
  Status,
  StatusDot,
} from "../../ds";
import {
  type InboxDetail,
  type InboxEvent,
  type InboxPage,
  useAttention,
  useInboxRows,
} from "../../state/inbox";

export function InboxScreen() {
  const view = useAttention();
  return <Loaded view={view}>{(page) => <InboxBody page={page} />}</Loaded>;
}

export function InboxBody({ page }: { readonly page: InboxPage }) {
  const { paging, shown } = useInboxRows(page.rows);
  const chosen = typeof page.shown === "object" ? page.shown.key : undefined;
  return (
    <MasterDetail
      focus={page.named ? "detail" : "list"}
      list={
        <ListPane
          title="Inbox"
          meta={`${page.rows.length} open`}
          footer={<Pager label="Inbox" paging={paging} />}
        >
          {page.rows.length === 0 ? (
            <Empty>Nothing needs you.</Empty>
          ) : (
            <List label="Needs you">
              {shown.map((row) => (
                <ListRow
                  key={row.key}
                  to={row.to}
                  selected={row.key === chosen}
                  lead={<StatusDot tone={row.tone} label={row.word} />}
                  title={row.word}
                  sub={row.subject}
                />
              ))}
            </List>
          )}
        </ListPane>
      }
      detail={<Detail shown={page.shown} />}
    />
  );
}

function Detail({ shown }: { readonly shown: InboxPage["shown"] }) {
  if (shown === undefined) return <InspectorEmpty>Nothing to show.</InspectorEmpty>;
  if (shown === "resolved") {
    return (
      <InspectorEmpty>
        Resolved. <Link to="/inbox">Back to Inbox</Link>
      </InspectorEmpty>
    );
  }
  return <Item key={shown.key} detail={shown} />;
}

function Item({ detail }: { readonly detail: InboxDetail }) {
  return (
    <Inspector
      crumbs={[{ label: "Inbox", to: "/inbox" }]}
      title={detail.title}
      line={
        <>
          <Status tone={detail.tone}>{detail.word}</Status> ·{" "}
          <span className="inbox-worker">
            <Link to={detail.worker.to}>{detail.worker.name}</Link>
          </span>
        </>
      }
      actions={<ButtonLink to={detail.worker.to}>Open worker</ButtonLink>}
    >
      {detail.facts.length === 0 ? null : (
        <Grid min="sm" label="Facts">
          {detail.facts.map((fact) => (
            <Card key={fact.label}>
              <p className="fact-label">{fact.label}</p>
              <p className="fact-value">{fact.value}</p>
            </Card>
          ))}
        </Grid>
      )}
      <Panel title="Recent events" flush>
        <EventList events={detail.events} />
      </Panel>
    </Inspector>
  );
}

function EventList({ events }: { readonly events: readonly InboxEvent[] }) {
  if (events.length === 0) return <Empty>No events in the last hour.</Empty>;
  return (
    <ul className="inbox-events">
      {events.map((event) => (
        <li key={event.key}>
          <Link to={event.to} className="inbox-event">
            <span className="mono muted">{event.time}</span>
            <span className={event.tone === undefined ? "mono" : `mono inbox-event-${event.tone}`}>
              {event.name}
            </span>
            <span className="inbox-event-text">{event.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

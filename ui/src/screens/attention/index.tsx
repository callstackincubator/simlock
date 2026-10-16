import "./attention.css";

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
  type AttentionDetail,
  type AttentionEvent,
  type AttentionPage,
  useAttention,
  useAttentionRows,
} from "../../state/attention";

export function AttentionScreen() {
  const view = useAttention();
  return <Loaded view={view}>{(page) => <AttentionBody page={page} />}</Loaded>;
}

export function AttentionBody({ page }: { readonly page: AttentionPage }) {
  const { paging, shown } = useAttentionRows(page.rows);
  const chosen = typeof page.shown === "object" ? page.shown.key : undefined;
  return (
    <MasterDetail
      focus={page.named ? "detail" : "list"}
      list={
        <ListPane
          title="Attention"
          meta={`${page.rows.length} open`}
          footer={<Pager label="Attention" paging={paging} />}
        >
          {page.rows.length === 0 ? (
            <Empty>Nothing needs attention.</Empty>
          ) : (
            <List label="Needs attention">
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

function Detail({ shown }: { readonly shown: AttentionPage["shown"] }) {
  if (shown === undefined) return <InspectorEmpty>Nothing to show.</InspectorEmpty>;
  if (shown === "resolved") {
    return (
      <InspectorEmpty>
        Resolved. <Link to="/attention">Back to Attention</Link>
      </InspectorEmpty>
    );
  }
  return <Item key={shown.key} detail={shown} />;
}

function Item({ detail }: { readonly detail: AttentionDetail }) {
  return (
    <Inspector
      crumbs={[{ label: "Attention", to: "/attention" }]}
      title={detail.title}
      line={
        <>
          <Status tone={detail.tone}>{detail.word}</Status> ·{" "}
          <span className="attention-worker">
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

function EventList({ events }: { readonly events: readonly AttentionEvent[] }) {
  if (events.length === 0) return <Empty>No events in the last hour.</Empty>;
  return (
    <ul className="attention-events">
      {events.map((event) => (
        <li key={event.key}>
          <Link to={event.to} className="attention-event">
            <span className="mono muted">{event.time}</span>
            <span
              className={event.tone === undefined ? "mono" : `mono attention-event-${event.tone}`}
            >
              {event.name}
            </span>
            <span className="attention-event-text">{event.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

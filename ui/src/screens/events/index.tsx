import "./events.css";

import {
  ButtonLink,
  ChoiceChips,
  Empty,
  Facts,
  Feed,
  Inspector,
  InspectorEmpty,
  Link,
  ListPane,
  ListRow,
  Loaded,
  type LoadView,
  MasterDetail,
  MinuteChart,
  MinuteTable,
  Panel,
} from "../../ds";
import {
  type EventDetail,
  type EventRow,
  type EventsChart,
  type EventsPage,
  SUBJECT_CHOICES,
  setSubject,
  type SubjectFilter,
  useEvents,
} from "../../state/events";

// why: a row is two lines of fixed height, so the feed can place the rows it draws by arithmetic.
const ROW_PX = 60;

export function EventsScreen() {
  return <EventsContent view={useEvents()} onSubject={setSubject} />;
}

export function EventsContent(props: {
  readonly view: LoadView<EventsPage>;
  readonly onSubject: (subject: SubjectFilter) => void;
}) {
  const { onSubject, view } = props;
  if (view.kind !== "ready") {
    return (
      <MasterDetail
        wide
        focus="list"
        list={
          <ListPane title="Events">
            <Loaded view={view}>{() => null}</Loaded>
          </ListPane>
        }
        detail={<InspectorEmpty>Nothing to show yet.</InspectorEmpty>}
      />
    );
  }
  return (
    <Loaded view={view}>
      {(page) => (
        <MasterDetail
          wide
          focus={page.named ? "detail" : "list"}
          list={<EventList page={page} onSubject={onSubject} />}
          detail={<Chosen page={page} />}
        />
      )}
    </Loaded>
  );
}

function EventList(props: {
  readonly page: EventsPage;
  readonly onSubject: (subject: SubjectFilter) => void;
}) {
  const { onSubject, page } = props;
  const { rows } = page;
  const chosenId = page.chosen.kind === "event" ? page.chosen.detail.id : undefined;
  return (
    <ListPane
      title="Events"
      meta="live"
      toolbar={
        <>
          <PerMinute chart={page.chart} />
          <ChoiceChips
            legend="Show"
            choices={SUBJECT_CHOICES}
            value={page.subject}
            onChange={onSubject}
          />
        </>
      }
    >
      {rows.length === 0 ? (
        <Empty>{page.held === 0 ? "No events in the last hour." : "No events of this kind."}</Empty>
      ) : (
        <Feed
          key={page.subject}
          label="Event feed"
          listLabel="Events"
          count={rows.length}
          rowHeight={ROW_PX}
          keyAt={(index) => rows[index]?.id ?? String(index)}
          newText={(count) => (count === 1 ? "1 new event" : `${count} new events`)}
          startAt={page.chosenIndex}
          renderRow={(index) => {
            const row = rows[index];
            return row === undefined ? null : <Row row={row} selected={row.id === chosenId} />;
          }}
        />
      )}
    </ListPane>
  );
}

function PerMinute({ chart }: { readonly chart: EventsChart }) {
  return (
    <div className="events-chart">
      <MinuteChart
        kind="columns"
        title="Events per minute"
        unit="events"
        minutes={chart.minutes}
        height={96}
      />
      <p className="chart-summary">{chart.summary}</p>
      <MinuteTable minutes={chart.minutes} heading="Events" />
    </div>
  );
}

function Row({ row, selected }: { readonly row: EventRow; readonly selected: boolean }) {
  return (
    <ListRow
      to={row.to}
      selected={selected}
      title={
        <>
          <time className="event-time mono" dateTime={row.iso}>
            {row.time}
          </time>
          <span className={toneClass(row.tone, "mono")}>{row.name}</span>
        </>
      }
      sub={row.summary}
    />
  );
}

function toneClass(tone: EventRow["tone"], base: string): string | undefined {
  return (
    [base, tone === undefined ? undefined : `event-${tone}`].filter(Boolean).join(" ") || undefined
  );
}

function Chosen({ page }: { readonly page: EventsPage }) {
  const { chosen } = page;
  if (chosen.kind === "none") return <InspectorEmpty>Nothing to show.</InspectorEmpty>;
  if (chosen.kind === "missing") {
    return (
      <InspectorEmpty>
        Event not in the last hour. <Link to="/events">Back to events</Link>
      </InspectorEmpty>
    );
  }
  return <Detail key={chosen.detail.id} detail={chosen.detail} />;
}

function Detail({ detail }: { readonly detail: EventDetail }) {
  return (
    <Inspector
      crumbs={[{ label: "Events", to: "/events" }, { label: detail.name }]}
      title={<span className={toneClass(detail.tone, "")}>{detail.name}</span>}
      mono
      line={<time dateTime={detail.iso}>{detail.line}</time>}
      actions={
        detail.action === undefined ? undefined : (
          <ButtonLink to={detail.action.to}>{detail.action.label}</ButtonLink>
        )
      }
    >
      <Panel title="Payload">
        {detail.pairs.length === 0 ? (
          <Empty>No payload.</Empty>
        ) : (
          <Facts raw facts={detail.pairs.map((pair) => ({ label: pair.key, value: pair.value }))} />
        )}
      </Panel>
    </Inspector>
  );
}

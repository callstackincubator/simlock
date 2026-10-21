import "./activity.css";

import {
  Button,
  ButtonLink,
  ChoiceChips,
  Drawer,
  Empty,
  Facts,
  Feed,
  focusAfterClosing,
  ListRow,
  Loaded,
  type LoadView,
  MinuteChart,
  MinuteTable,
  Page,
  SearchField,
  Toolbar,
} from "../../ds";
import { useItemId, useListDrawer } from "../../state/drawer";
import {
  type EventDetail,
  type EventRow,
  type EventsChart,
  type EventsPage,
  type HistoryEnd,
  SUBJECT_CHOICES,
  setQuery,
  setSubject,
  type SubjectFilter,
  useEvents,
} from "../../state/events";

// why: a row is two lines of fixed height, so the feed can place the rows it draws by arithmetic.
const ROW_PX = 60;

export function ActivityScreen() {
  const view = useEvents();
  const urlId = useItemId("/activity");
  const { close, fromList } = useListDrawer("/activity", urlId);
  return (
    <ActivityContent
      view={view}
      onSubject={setSubject}
      onSearch={setQuery}
      onClose={close}
      finalFocus={() =>
        urlId === undefined
          ? null
          : focusAfterClosing({
              fromList,
              links: ".feed-list a",
              path: `/activity/${encodeURIComponent(urlId)}`,
            })
      }
    />
  );
}

export function ActivityContent(props: {
  readonly view: LoadView<EventsPage>;
  readonly onSubject: (subject: SubjectFilter) => void;
  readonly onSearch: (query: string) => void;
  readonly onClose: () => void;
  readonly finalFocus: () => HTMLElement | null;
}) {
  const { finalFocus, onClose, onSearch, onSubject, view } = props;
  return (
    <Page title="Activity" actions={<span className="muted">live</span>}>
      <Loaded view={view}>
        {(page) => (
          <>
            <PerMinute chart={page.chart} />
            <Toolbar
              start={
                <ChoiceChips
                  legend="Show"
                  choices={SUBJECT_CHOICES}
                  value={page.subject}
                  onChange={onSubject}
                />
              }
              end={<SearchField label="Search events" value={page.query} onChange={onSearch} />}
            />
            <EventList page={page} />
            {page.urlId === undefined ? null : (
              <Drawer
                key={page.urlId}
                title={<DrawerTitle page={page} />}
                onClose={onClose}
                finalFocus={finalFocus}
              >
                <EventDrawerBody page={page} />
              </Drawer>
            )}
          </>
        )}
      </Loaded>
    </Page>
  );
}

function EventList({ page }: { readonly page: EventsPage }) {
  const { rows } = page;
  const chosenId = page.chosen.kind === "event" ? page.chosen.detail.id : undefined;
  // why: a chip or a search shows few of the events held, so scrolling would not tell how many
  // more are worth loading; the reader asks for each page.
  const narrowed = page.subject !== "all" || page.query !== "";
  if (page.held === 0) {
    return page.end === undefined ? (
      <p className="muted">Loading…</p>
    ) : (
      <EndRow end={page.end} onRetry={page.loadOlder} />
    );
  }
  if (rows.length === 0) {
    return (
      <>
        <Empty>
          {page.query === ""
            ? `No ${page.subject} events among those loaded.`
            : `No events match ${page.query} among those loaded.`}
        </Empty>
        <Footer page={page} narrowed />
      </>
    );
  }
  return (
    <Feed
      key={`${page.subject}/${page.query}`}
      label="Event feed"
      listLabel="Events"
      count={rows.length}
      rowHeight={ROW_PX}
      keyAt={(index) => rows[index]?.id ?? String(index)}
      newText={(count) => (count === 1 ? "1 new event" : `${count} new events`)}
      startAt={page.chosenIndex}
      onNearEnd={narrowed ? undefined : page.loadOlder}
      footer={<Footer page={page} narrowed={narrowed} />}
      renderRow={(index) => {
        const row = rows[index];
        return row === undefined ? null : <Row row={row} selected={row.id === chosenId} />;
      }}
    />
  );
}

function Footer(props: { readonly page: EventsPage; readonly narrowed: boolean }) {
  const { narrowed, page } = props;
  if (page.end !== undefined) return <EndRow end={page.end} onRetry={page.loadOlder} />;
  if (!narrowed) return null;
  return (
    <p className="feed-end">
      <Button type="button" onClick={page.loadOlder}>
        Load older events
      </Button>
    </p>
  );
}

function EndRow(props: { readonly end: HistoryEnd; readonly onRetry: () => void }) {
  const { end, onRetry } = props;
  return (
    <p className="feed-end muted">
      {end.text}
      {end.retry ? (
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </p>
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

function DrawerTitle({ page }: { readonly page: EventsPage }) {
  const { chosen } = page;
  if (chosen.kind !== "event") return <>Event</>;
  return <span className={toneClass(chosen.detail.tone, "")}>{chosen.detail.name}</span>;
}

export function EventDrawerBody({ page }: { readonly page: EventsPage }) {
  const { chosen } = page;
  if (chosen.kind === "event") return <Detail detail={chosen.detail} />;
  return (
    <p className="muted event-drawer-body">
      This event is not among those loaded. Older events load as you scroll the list, or with Load
      older events.
    </p>
  );
}

function Detail({ detail }: { readonly detail: EventDetail }) {
  return (
    <div className="event-drawer-body">
      <p className="event-line">
        <time dateTime={detail.iso}>{detail.line}</time>
      </p>
      {detail.action === undefined ? null : (
        <p>
          <ButtonLink to={detail.action.to}>{detail.action.label}</ButtonLink>
        </p>
      )}
      <h3 className="event-payload-title">Payload</h3>
      {detail.pairs.length === 0 ? (
        <Empty>No payload.</Empty>
      ) : (
        <Facts raw facts={detail.pairs.map((pair) => ({ label: pair.key, value: pair.value }))} />
      )}
    </div>
  );
}

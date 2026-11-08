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
  Icon,
  type IconName,
  Link,
  Loaded,
  type LoadView,
  MinuteChart,
  MinuteTable,
  Page,
  Pill,
  SearchField,
} from "../../ds";
import { useItemId, useListDrawer } from "../../state/drawer";
import {
  type ActivityFilter,
  type ActivityRow,
  chooseKind,
  chooseProblems,
  chooseWorker,
  type EventDetail,
  type EventsChart,
  type EventsPage,
  type Facets,
  type HistoryEnd,
  type Kind,
  setQuery,
  useEvents,
} from "../../state/events";
import { type ConsoleRange, useRange } from "../../state/range";

// why: a row is one line of fixed height, so the feed can place the rows it draws by arithmetic.
const ROW_PX = 38;

const RANGES: readonly { readonly value: ConsoleRange; readonly label: string }[] = [
  { label: "1 h", value: "1h" },
  { label: "6 h", value: "6h" },
  { label: "24 h", value: "24h" },
  { label: "7 d", value: "7d" },
];

const KIND_ICONS: Readonly<Record<Kind, IconName>> = {
  baseline: "baselines",
  device: "device",
  lease: "leases",
  other: "events",
  queue: "waiting",
  worker: "workers",
};

export interface FacetActions {
  readonly onKind: (filter: ActivityFilter, kind: Kind) => void;
  readonly onWorker: (filter: ActivityFilter, worker: string) => void;
  readonly onProblems: (filter: ActivityFilter) => void;
}

const FACET_ACTIONS: FacetActions = {
  onKind: chooseKind,
  onProblems: chooseProblems,
  onWorker: chooseWorker,
};

export function ActivityScreen() {
  const view = useEvents();
  const [range, setRange] = useRange();
  const urlId = useItemId("/activity");
  const { close, fromList } = useListDrawer("/activity", urlId);
  return (
    <ActivityContent
      view={view}
      range={range}
      onRange={setRange}
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
  readonly range: ConsoleRange;
  readonly onRange: (range: ConsoleRange) => void;
  readonly onSearch: (query: string) => void;
  readonly onClose: () => void;
  readonly finalFocus: () => HTMLElement | null;
  readonly actions?: FacetActions;
}) {
  const { actions = FACET_ACTIONS, finalFocus, onClose, onRange, onSearch, range, view } = props;
  const query = view.kind === "ready" ? view.data.query : "";
  return (
    <Page
      title="Activity"
      actions={
        <>
          <SearchField
            label="Search events"
            placeholder="Filter events"
            value={query}
            onChange={onSearch}
          />
          <ChoiceChips legend="Range" choices={RANGES} value={range} onChange={onRange} />
        </>
      }
    >
      <Loaded view={view}>
        {(page) => (
          <>
            <div className="activity-grid">
              <FacetCard page={page} actions={actions} />
              <section className="activity-card activity-feed" aria-label="Events">
                <PerMinute chart={page.chart} />
                <EventList page={page} />
              </section>
            </div>
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

function FacetCard(props: { readonly page: EventsPage; readonly actions: FacetActions }) {
  const { actions, page } = props;
  const { facets, filter } = page;
  return (
    <section className="activity-card activity-facets" aria-label="Filters" tabIndex={0}>
      <FacetGroup
        title="Kind"
        facets={facets.kinds}
        onToggle={(v) => actions.onKind(filter, v as Kind)}
      />
      <FacetGroup
        title="State"
        facets={[facets.problems]}
        onToggle={() => actions.onProblems(filter)}
      />
      <FacetGroup
        title="Worker"
        facets={facets.workers}
        mono
        onToggle={(v) => actions.onWorker(filter, v)}
      />
    </section>
  );
}

function FacetGroup(props: {
  readonly title: string;
  readonly facets: Facets["kinds"];
  readonly mono?: boolean;
  readonly onToggle: (value: string) => void;
}) {
  const { facets, mono = false, onToggle, title } = props;
  return (
    <div role="group" aria-label={title} className="facet-group">
      <h2 className="activity-label facet-title">{title}</h2>
      <div className="facet-list">
        {facets.map((facet) => (
          <label key={facet.value} className="facet">
            <input type="checkbox" checked={facet.checked} onChange={() => onToggle(facet.value)} />
            <span className={mono ? "facet-name mono" : "facet-name"} title={facet.label}>
              {facet.label}
            </span>
            <span className="facet-count mono">{facet.count}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function isNarrowed(page: EventsPage): boolean {
  return (
    page.filter.kinds.length > 0 ||
    page.filter.problems ||
    page.filter.workers.length > 0 ||
    page.query !== ""
  );
}

function NothingHeld({ page }: { readonly page: EventsPage }) {
  return page.end === undefined ? (
    <p className="muted activity-note">Loading…</p>
  ) : (
    <EndRow end={page.end} onRetry={page.loadOlder} />
  );
}

function NoMatches({ page }: { readonly page: EventsPage }) {
  return (
    <>
      <Empty>
        {page.query === ""
          ? "No events match these filters among those loaded."
          : `No events match ${page.query} among those loaded.`}
      </Empty>
      <Footer page={page} narrowed />
    </>
  );
}

function EventList({ page }: { readonly page: EventsPage }) {
  const { rows } = page;
  const chosenId = page.chosen.kind === "event" ? page.chosen.detail.id : undefined;
  // why: a facet, a search or a range shows few of the events held, so scrolling would not tell how
  // many more are worth loading; the reader asks for each page.
  const narrowed = isNarrowed(page);
  if (page.held === 0) return <NothingHeld page={page} />;
  if (rows.length === 0) return <NoMatches page={page} />;
  return (
    <Feed
      key={`${page.query}/${page.range}/${page.filter.kinds.join()}/${page.filter.problems}/${page.filter.workers.join()}`}
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
  if (!narrowed && page.coverage === undefined) return null;
  return (
    <p className="feed-end">
      {page.coverage === undefined ? null : <span className="muted">{page.coverage}</span>}
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
    <div className="activity-chart">
      <div className="activity-chart-head">
        <h2 className="activity-label">Events per minute</h2>
        <Pill tone="ok">live</Pill>
        <p className="activity-figures" aria-hidden="true">
          {chart.short}
        </p>
        <p className="chart-summary visually-hidden">{chart.summary}</p>
      </div>
      <MinuteChart
        kind="columns"
        compact
        title="Events per minute"
        unit="events"
        minutes={chart.minutes}
        height={46}
      />
      <MinuteTable minutes={chart.minutes} heading="Events" />
    </div>
  );
}

function Row({ row, selected }: { readonly row: ActivityRow; readonly selected: boolean }) {
  return (
    <li className="list-item">
      <Link to={row.to} className="event-row" aria-current={selected ? "page" : undefined}>
        <span
          className={row.mark === undefined ? "event-icon" : `event-icon event-icon-${row.mark}`}
        >
          <Icon name={KIND_ICONS[row.kind]} />
        </span>
        <span className="event-name mono">{row.name}</span>
        <span className="event-subject">
          {row.subject}
          {row.detail === "" ? null : <span className="muted"> · {row.detail}</span>}
        </span>
        <span className="event-worker mono" title={row.workerTitle}>
          {row.worker}
        </span>
        <time className="event-time mono" dateTime={row.iso}>
          {row.time}
        </time>
      </Link>
    </li>
  );
}

function DrawerTitle({ page }: { readonly page: EventsPage }) {
  const { chosen } = page;
  if (chosen.kind !== "event") return <>Event</>;
  return <span>{chosen.detail.name}</span>;
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

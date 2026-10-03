import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { MinuteChart, MinuteTable } from "../charts";
import { useApi } from "../console-context";
import { PageHeader, Panel, StatCards } from "../layout";
import { browserClock } from "../live/browser";
import type { ResourceState } from "../live/connection";
import { useLiveEvents, useLiveResource, useNow, useStreamOpened } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { formatCount } from "../paging";
import { EventFeed } from "./event-feed";
import {
  type ConsoleEvent,
  eventsStats,
  keyOf,
  MAX_EVENTS,
  payloadPairs,
  type Subject,
  subjectOf,
  timeOfDay,
  workerIdOf,
} from "./events-model";
import { eventsPerMinute, extremes, type MinuteCount } from "./history-model";
import { type WorkerList, type WorkerView, workerName } from "./workers-model";

const FILTERS: readonly { readonly value: Subject | "all"; readonly label: string }[] = [
  { label: "All", value: "all" },
  { label: "Leases", value: "lease" },
  { label: "Devices", value: "device" },
  { label: "Workers", value: "worker" },
  { label: "Components", value: "component" },
  { label: "Other", value: "other" },
];

/**
 * The events the calling view holds, newest first: the last hour when it opened, then each one
 * the stream sends while it is on screen, filled as `EventFeed` says. The newest
 * {@link MAX_EVENTS} are kept; none drops off by age.
 */
export function useRecentEvents(): ResourceState<readonly ConsoleEvent[]> {
  const api = useApi();
  const [feed] = useState(() => new EventFeed((path) => api.getJson(path), browserClock));
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  return useSyncExternalStore(feed.subscribe, feed.snapshot);
}

/**
 * Recent events, newest first, with new ones added as the stream sends them (ADR 0013 §1, §2).
 * Each shows the payload as the daemon sent it: keeping secrets out of events is the daemon's
 * job, not the console's.
 */
export function EventsView() {
  const state = useRecentEvents();
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers;
  const now = useNow();
  const [filter, setFilter] = useState<Subject | "all">("all");
  return (
    <section className="view">
      <PageHeader
        title="Events"
        subtitle="What happened on the daemon in the last hour, newest first, as it happens."
      />
      <Loaded state={state}>
        {(events) => {
          const shown = shownEvents(events, filter);
          return (
            <>
              <StatCards stats={eventsStats(shown, events.length, filter === "all")} />
              <EventsPerMinute minutes={eventsPerMinute(events, now.server)} />
              <Panel
                title="Recent events"
                description={`Newest first, each with its payload. The newest ${formatCount(MAX_EVENTS)} are kept.`}
              >
                <fieldset className="filter">
                  <legend>Show</legend>
                  {FILTERS.map((option) => (
                    <label key={option.value}>
                      <input
                        type="radio"
                        name="event-subject"
                        value={option.value}
                        checked={filter === option.value}
                        onChange={() => setFilter(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
                <EventList events={events} workers={workers} filter={filter} />
              </Panel>
            </>
          );
        }}
      </Loaded>
    </section>
  );
}

/** The events the filter lets through, newest first. */
function shownEvents(
  events: readonly ConsoleEvent[],
  filter: Subject | "all",
): readonly ConsoleEvent[] {
  return filter === "all" ? events : events.filter((event) => subjectOf(event.event) === filter);
}

/** The column chart of every event the view holds, minute by minute, with its numbers as text. */
function EventsPerMinute({ minutes }: { readonly minutes: readonly MinuteCount[] }) {
  const total = minutes.reduce((sum, minute) => sum + minute.count, 0);
  const busiest = extremes(minutes)?.highest;
  return (
    <Panel
      title="Events per minute"
      description="How many of the events below happened in each minute of the last hour, whatever the filter shows."
    >
      <MinuteChart kind="columns" title="Events per minute" unit="events" minutes={minutes} />
      <p className="chart-summary">
        {total === 1 ? "1 event" : `${total} events`} in the last hour
        {busiest === undefined || busiest.count === 0 ? null : (
          <>
            ; the busiest minute was {busiest.label}, with {busiest.count}
          </>
        )}
        .
      </p>
      <MinuteTable minutes={minutes} heading="Events" />
    </Panel>
  );
}

/**
 * The events, newest first, in a scrolling box of fixed height. Each one's payload is a list of
 * its keys and values. A filter starts the box again at the top.
 */
export function EventList(props: {
  readonly events: readonly ConsoleEvent[];
  /** The workers the daemon lists, to name an event's worker; `undefined` until read. */
  readonly workers: readonly WorkerView[] | undefined;
  /** Only the events about this subject; all of them when absent. */
  readonly filter?: Subject | "all";
}) {
  const { filter = "all", workers } = props;
  if (props.events.length === 0) return <p className="muted">No events in the last hour.</p>;
  const events = shownEvents(props.events, filter);
  if (events.length === 0) return <p className="muted">No events of this kind.</p>;
  return <Feed key={filter} events={events} workers={workers} />;
}

/** The box's height and a row's before either is measured: what a first draw lays out. */
const FEED_HEIGHT_PX = 640;
const ROW_ESTIMATE_PX = 120;

/** Rows drawn past each edge of the box, so a short scroll shows rows already there. */
const OVERSCAN = 5;

/**
 * The feed's scrolling box. Only the rows in view, and {@link OVERSCAN} past each edge, are in
 * the page; each is measured as it is drawn, since a payload that wraps makes its row taller.
 *
 * New events come in at the top. While the box is at the top, they push the rows down, so the
 * newest is always in view. Once the operator scrolls down, the row they are reading stays where
 * it is (`anchorTo: "end"` keeps the row at the top of the box in place when rows are added
 * above it), and a button counts the events that came in since; it scrolls back to the top.
 */
function Feed(props: {
  readonly events: readonly ConsoleEvent[];
  readonly workers: readonly WorkerView[] | undefined;
}) {
  const { events, workers } = props;
  const box = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const newest = events[0] === undefined ? undefined : keyOf(events[0]);
  // The newest event the operator saw at the top of the box: every event above it is new to them.
  const [seen, setSeen] = useState(newest);
  useEffect(() => {
    if (atTop) setSeen(newest);
  }, [atTop, newest]);
  const virtualizer = useVirtualizer({
    anchorTo: atTop ? "start" : "end",
    count: events.length,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => {
      const event = events[index];
      return event === undefined ? index : keyOf(event);
    },
    getScrollElement: () => box.current,
    initialRect: { height: FEED_HEIGHT_PX, width: 0 },
    overscan: OVERSCAN,
  });
  const unseen = atTop
    ? 0
    : Math.max(
        0,
        events.findIndex((event) => keyOf(event) === seen),
      );
  const toTop = () => {
    virtualizer.scrollToOffset(0);
    box.current?.focus();
  };
  return (
    <div className="feed">
      {unseen === 0 ? null : (
        <button className="button button-secondary feed-new" type="button" onClick={toTop}>
          {unseen === 1 ? "1 new event" : `${formatCount(unseen)} new events`}
        </button>
      )}
      <div
        ref={box}
        className="feed-box"
        role="region"
        aria-label="Event feed"
        tabIndex={0}
        onScroll={(event) => setAtTop(event.currentTarget.scrollTop < 1)}
      >
        <ol className="events" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const event = events[item.index];
            if (event === undefined) return null;
            return (
              <li
                key={item.key.toString()}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="event"
                aria-setsize={events.length}
                aria-posinset={item.index + 1}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <EventRow event={event} workers={workers} />
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/** One event: its time, its name, its worker on a gateway, and its payload. */
function EventRow(props: {
  readonly event: ConsoleEvent;
  readonly workers: readonly WorkerView[] | undefined;
}) {
  const { event, workers } = props;
  const workerId = workerIdOf(event);
  const pairs = payloadPairs(event.payload);
  return (
    <>
      <p className="event-head">
        <time className="mono" dateTime={new Date(event.timestamp).toISOString()}>
          {timeOfDay(event.timestamp)}
        </time>
        <span className="event-name mono">{event.event}</span>
        {workerId === undefined ? null : (
          <span className="event-worker">{eventWorkerName(workerId, workers)}</span>
        )}
      </p>
      {pairs.length === 0 ? null : (
        <dl className="event-payload">
          {pairs.map((pair) => (
            <div key={pair.key}>
              <dt className="mono">{pair.key}</dt>
              <dd className="mono">{pair.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/**
 * The name to show for the worker an event is about: its label when the daemon lists it, its
 * id when the worker has no label or is not listed (yet, or any more).
 */
function eventWorkerName(id: string, workers: readonly WorkerView[] | undefined): string {
  const worker = workers?.find((candidate) => candidate.id === id);
  return worker === undefined ? id : workerName(worker);
}

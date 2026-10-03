import { useEffect, useState, useSyncExternalStore } from "react";

import { MinuteChart, MinuteTable } from "../charts";
import { useApi } from "../console-context";
import { PageHeader, Panel, StatCards } from "../layout";
import { browserClock } from "../live/browser";
import type { ResourceState } from "../live/connection";
import { useLiveEvents, useLiveResource, useNow, useStreamOpened } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { EventFeed } from "./event-feed";
import {
  type ConsoleEvent,
  eventsStats,
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
 * The events of the last hour, newest first, filled from `GET /v1/events` and the stream as
 * `EventFeed` says, while the calling view is on screen.
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
                description="The newest 1000 events of the last hour, each with its payload."
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

/** The events, newest first. Each one's payload is a list of its keys and values. */
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
  return (
    <ol className="events">
      {events.map((event) => {
        const workerId = workerIdOf(event);
        const pairs = payloadPairs(event.payload);
        return (
          <li key={`${event.seq}:${event.timestamp}`} className="event">
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
          </li>
        );
      })}
    </ol>
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

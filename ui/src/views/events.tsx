import { useEffect, useState, useSyncExternalStore } from "react";

import { useApi } from "../console-context";
import { useLiveEvents, useLiveResource, useStreamOpened } from "../live/live-context";
import { Loaded } from "../live/route-state";
import { EventFeed } from "./event-feed";
import {
  type ConsoleEvent,
  payloadPairs,
  type Subject,
  subjectOf,
  timeOfDay,
  workerIdOf,
} from "./events-model";
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
 * Recent events, newest first, with new ones added as the stream sends them (ADR 0013 §1, §2).
 * Each shows the payload as the daemon sent it: keeping secrets out of events is the daemon's
 * job, not the console's.
 */
export function EventsView() {
  const api = useApi();
  const [feed] = useState(() => new EventFeed((path) => api.getJson(path)));
  useLiveEvents(feed.streamEvent);
  useStreamOpened(feed.streamOpened);
  useEffect(() => feed.start(), [feed]);
  const state = useSyncExternalStore(feed.subscribe, feed.snapshot);
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers;
  const [filter, setFilter] = useState<Subject | "all">("all");
  return (
    <section className="view">
      <h1>Events</h1>
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
      <Loaded state={state}>
        {(events) => (
          <EventList
            events={
              filter === "all"
                ? events
                : events.filter((event) => subjectOf(event.event) === filter)
            }
            workers={workers}
            filtered={filter !== "all"}
          />
        )}
      </Loaded>
    </section>
  );
}

/** The events, newest first. Each one's payload is a list of its keys and values. */
export function EventList(props: {
  readonly events: readonly ConsoleEvent[];
  /** The workers the daemon lists, to name an event's worker; `undefined` until read. */
  readonly workers: readonly WorkerView[] | undefined;
  readonly filtered?: boolean;
}) {
  const { events, filtered = false, workers } = props;
  if (events.length === 0) {
    return (
      <p className="muted">
        {filtered ? "No events of this kind." : "No events in the last hour."}
      </p>
    );
  }
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

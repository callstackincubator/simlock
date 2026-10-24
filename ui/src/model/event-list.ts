import { eventSummary, eventTone } from "./activity";
import { inboxItems } from "../../../src/contract/inbox";
import {
  type ConsoleEvent,
  payloadPairs,
  type Subject,
  subjectOf,
  textField,
  timeOfDay,
  workerIdOf,
} from "./events";
import { eventsPerMinute, extremes, type MinuteCount } from "./history";
import { type LeaseRecord, leasePath } from "./leases";
import { formatCount, writeQuery } from "./paging";
import { inboxPath, itemPath } from "./paths";
import type { Tone } from "./tones";
import type { WaitingRequest } from "./waiting";
import { type WorkerView, workerPath } from "./workers";

export type SubjectFilter = Subject | "all";

export const SUBJECT_CHOICES: readonly { readonly value: SubjectFilter; readonly label: string }[] =
  [
    { label: "All", value: "all" },
    { label: "Leases", value: "lease" },
    { label: "Devices", value: "device" },
    { label: "Workers", value: "worker" },
    { label: "Components", value: "component" },
    { label: "Other", value: "other" },
  ];

// why: the filter lives in the URL as `?subject=`, so a reload or a shared link shows the same
// events; a value this console does not know is the whole feed, not an empty one.
export function readSubject(search: string): SubjectFilter {
  const asked = new URLSearchParams(search).get("subject");
  return SUBJECT_CHOICES.find((choice) => choice.value === asked)?.value ?? "all";
}

// why: any other key of the query is not the filter's to touch, so only `subject` is set or
// dropped.
export function writeSubject(search: string, subject: SubjectFilter): string {
  const params = new URLSearchParams(search);
  if (subject === "all") params.delete("subject");
  else params.set("subject", subject);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export function shownEvents(
  events: readonly ConsoleEvent[],
  subject: SubjectFilter,
): readonly ConsoleEvent[] {
  return subject === "all" ? events : events.filter((event) => subjectOf(event.event) === subject);
}

const DAY = 86_400_000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// why: the feed holds days of history, so an event can be from before midnight, and "today" would then be
// false.
export function dayWord(timestamp: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return new Date(timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export interface EventRow {
  readonly id: string;
  readonly to: string;
  readonly iso: string;
  readonly time: string;
  readonly name: string;
  readonly tone?: Tone;
  readonly summary: string;
}

// why: a row keeps the filter and the search in its link, so choosing an event does not undo them.
export function eventRows(
  events: readonly ConsoleEvent[],
  workers: readonly WorkerView[],
  subject: SubjectFilter,
  search = "",
): readonly EventRow[] {
  const query = writeQuery(writeSubject("", subject), search);
  const wanted = search.toLowerCase();
  const rows = shownEvents(events, subject).map((event) => {
    const tone = eventTone(event.event);
    return {
      id: event.id,
      iso: new Date(event.timestamp).toISOString(),
      name: event.event,
      summary: eventSummary(event, workers),
      time: timeOfDay(event.timestamp),
      to: `${itemPath("/activity", event.id)}${query}`,
      ...(tone === undefined ? {} : { tone }),
    };
  });
  // why: the match is over what a row shows, its name and its summary line, and over no other
  // part of the payload.
  return wanted === ""
    ? rows
    : rows.filter(
        (row) =>
          row.name.toLowerCase().includes(wanted) || row.summary.toLowerCase().includes(wanted),
      );
}

export interface EventAction {
  readonly label: string;
  readonly to: string;
}

export interface EventDetail {
  readonly id: string;
  readonly name: string;
  readonly tone?: Tone;
  readonly iso: string;
  readonly line: string;
  readonly action?: EventAction;
  readonly pairs: readonly { readonly key: string; readonly value: string }[];
}

export interface EventPlaces {
  readonly workers: readonly WorkerView[];
  readonly leases: readonly LeaseRecord[];
  readonly requests: readonly WaitingRequest[];
}

// why: a link goes only where the console has a page now: a released lease, an answered request or
// an unlisted worker has none. A relayed worker event names the lease as the worker did, and a
// gateway lists it as `<workerId>.<id>`, so both spellings are tried.
export function eventAction(event: ConsoleEvent, places: EventPlaces): EventAction | undefined {
  const { payload } = event;
  const workerId = workerIdOf(event);
  const leaseId = textField(payload, "leaseId");
  const lease =
    leaseId === undefined
      ? undefined
      : places.leases.find(
          (entry) =>
            entry.id === leaseId ||
            (workerId !== undefined && entry.id === `${workerId}.${leaseId}`),
        );
  if (lease !== undefined) return { label: "Open lease", to: leasePath(lease.id) };
  const requestId = textField(payload, "requestId");
  const request = places.requests.find((entry) => entry.id === requestId);
  if (request !== undefined) {
    return { label: "Open request", to: itemPath("/queue", request.id) };
  }
  const deviceId = textField(payload, "deviceId");
  const item = inboxItems(places.workers).find(
    (entry) =>
      "device" in entry && entry.device.workerId === workerId && entry.device.id === deviceId,
  );
  if (item !== undefined) {
    return { label: "Open Inbox item", to: inboxPath(item.key) };
  }
  const worker = places.workers.find((entry) => entry.id === workerId);
  if (worker !== undefined) return { label: "Open worker", to: workerPath(worker.id) };
  return undefined;
}

// why: the payload is shown whole, as the daemon sent it: keeping secrets out of events is the
// daemon's job, not the console's.
export function eventDetail(event: ConsoleEvent, places: EventPlaces, now: number): EventDetail {
  const tone = eventTone(event.event);
  const summary = eventSummary(event, places.workers);
  const when = `${timeOfDay(event.timestamp)} ${dayWord(event.timestamp, now)}`;
  const action = eventAction(event, places);
  return {
    id: event.id,
    iso: new Date(event.timestamp).toISOString(),
    line: summary === event.event ? when : `${when} · ${summary}`,
    name: event.event,
    pairs: payloadPairs(event.payload),
    ...(action === undefined ? {} : { action }),
    ...(tone === undefined ? {} : { tone }),
  };
}

export interface EventsChart {
  readonly minutes: readonly MinuteCount[];
  readonly summary: string;
}

// why: the chart counts every event held, whatever the filter shows, so its numbers stay put when
// a chip is chosen; they are also text, for whoever cannot see the columns.
export function eventsChart(events: readonly ConsoleEvent[], now: number): EventsChart {
  const minutes = eventsPerMinute(events, now);
  const total = minutes.reduce((sum, minute) => sum + minute.count, 0);
  const busiest = extremes(minutes)?.highest;
  const count = `${total === 1 ? "1 event" : `${formatCount(total)} events`} in the last hour`;
  const peak =
    busiest === undefined || busiest.count === 0
      ? ""
      : `; the busiest minute was ${busiest.label}, with ${formatCount(busiest.count)}`;
  return { minutes, summary: `${count}${peak}.` };
}

export type Chosen =
  | { readonly kind: "none" }
  | { readonly kind: "missing"; readonly id: string }
  | { readonly kind: "event"; readonly detail: EventDetail };

// why: the drawer opens only for an id in the URL; an id the console does not hold (older than
// what has loaded) is said so, not guessed at. An id is looked up among every event held, so an
// event the filter or the search hides still opens.
export function chosenEvent(
  events: readonly ConsoleEvent[],
  id: string | undefined,
  places: EventPlaces,
  now: number,
): Chosen {
  if (id === undefined) return { kind: "none" };
  const event = events.find((entry) => entry.id === id);
  if (event === undefined) return { id, kind: "missing" };
  return { detail: eventDetail(event, places, now), kind: "event" };
}

/**
 * The facts the events view shows, from `GET /v1/events` and the event stream (ADR 0013 §1,
 * §2). Pure, so the view stays rendering and these stay tested. Wire input is a claim: an
 * envelope is read field by field, and an event name or payload this console has never heard
 * of is shown as it came.
 */

/** One business event, as the daemon sent it. */
export interface ConsoleEvent {
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
  /** The payload as sent: any JSON value, or `undefined` when the envelope had none. */
  readonly payload: unknown;
}

/** How many events the view keeps. Older ones drop off the end. */
export const MAX_EVENTS = 1000;

/**
 * The window the view loads when it opens, the same as `simlock events --since 1h`, so the two
 * show the same events.
 */
export const RECENT = "1h";

/**
 * An envelope off the wire, or `undefined` when it is not one: without a numeric `seq`, a
 * `timestamp` that is a date, and a string `event`, it cannot be placed in time or told apart
 * from another.
 */
export function readEvent(data: unknown): ConsoleEvent | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { event, payload, seq, timestamp } = data as Record<string, unknown>;
  if (typeof seq !== "number" || typeof timestamp !== "number" || typeof event !== "string") {
    return undefined;
  }
  if (Number.isNaN(new Date(timestamp).getTime())) return undefined;
  return { event, payload, seq, timestamp };
}

/**
 * The events in a `GET /v1/events` answer. Throws when the answer has no `events` list, so the
 * view says it could not read it rather than showing nothing.
 */
export function readReplay(body: unknown): readonly ConsoleEvent[] {
  const events = (body as { readonly events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new SyntaxError("The answer has no events list");
  return events.flatMap((data: unknown) => readEvent(data) ?? []);
}

/**
 * What makes two events the same: `seq` and `timestamp` both. `seq` alone starts again when the
 * daemon restarts (ADR 0013 §2).
 */
function keyOf(event: ConsoleEvent): string {
  return `${event.seq}:${event.timestamp}`;
}

/** Newest first: by time, and by `seq` within the same millisecond. */
function newestFirst(a: ConsoleEvent, b: ConsoleEvent): number {
  return b.timestamp - a.timestamp || b.seq - a.seq;
}

/**
 * `current` with `incoming` added: each event once, newest first, and only the newest
 * {@link MAX_EVENTS}. Returns `current` itself when nothing new came.
 */
export function mergeEvents(
  current: readonly ConsoleEvent[],
  incoming: readonly ConsoleEvent[],
): readonly ConsoleEvent[] {
  const seen = new Set(current.map(keyOf));
  const added: ConsoleEvent[] = [];
  for (const event of incoming) {
    const key = keyOf(event);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(event);
  }
  if (added.length === 0) return current;
  return [...current, ...added].sort(newestFirst).slice(0, MAX_EVENTS);
}

/**
 * The `since` that covers a gap of `ms` milliseconds, in whole seconds, rounded up, so the gap's
 * first event is inside it (ADR 0013 §5).
 */
export function sinceFor(ms: number): string {
  return `${Math.ceil(ms / 1_000)}s`;
}

/** The subjects the filter offers. `other` is every subject not named here. */
const SUBJECTS = ["lease", "device", "worker", "component"] as const;

export type Subject = (typeof SUBJECTS)[number] | "other";

/** The subject of an event: the part of its name before the first dot (`lease.granted`). */
export function subjectOf(name: string): Subject {
  const subject = name.split(".", 1)[0];
  return SUBJECTS.find((known) => known === subject) ?? "other";
}

/**
 * The worker an event is about, from the `workerId` a gateway adds to each worker's event, or
 * the one a gateway's own `worker.*` events carry. `undefined` on a single host, and for
 * `worker.rejected`: its `workerId` is what a refused dial claimed, so it names no worker, and
 * shows only in the payload.
 */
export function workerIdOf(event: ConsoleEvent): string | undefined {
  const { payload } = event;
  if (event.event === "worker.rejected" || typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const workerId = (payload as Record<string, unknown>).workerId;
  return typeof workerId === "string" ? workerId : undefined;
}

/**
 * The payload as key and value pairs, in the order the daemon sent them. A string shows as
 * itself; any other value as its JSON. A payload that is not an object shows as one pair,
 * `payload`, so an unknown shape is still shown whole.
 */
export function payloadPairs(
  payload: unknown,
): readonly { readonly key: string; readonly value: string }[] {
  if (payload === undefined) return [];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [{ key: "payload", value: valueText(payload) }];
  }
  return Object.entries(payload).map(([key, value]) => ({ key, value: valueText(value) }));
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** An event's time of day, `HH:MM:SS` on the browser's clock face. */
export function timeOfDay(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

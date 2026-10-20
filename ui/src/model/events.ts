export interface ConsoleEvent {
  // why: names the event for good: survives a daemon restart.
  readonly id: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly event: string;
  readonly payload: unknown;
}

export const MAX_EVENTS = 10_000;

// why: the same window as `simlock events --since 1h`, so the two show the same events.
export const RECENT = "1h";

// why: an envelope without a numeric `seq`, a date `timestamp`, and a string `event` and `id`
// cannot be placed in time or told apart from another, so it is dropped.
export function readEvent(data: unknown): ConsoleEvent | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { event, id, payload, seq, timestamp } = data as Record<string, unknown>;
  if (
    typeof seq !== "number" ||
    typeof timestamp !== "number" ||
    typeof event !== "string" ||
    typeof id !== "string"
  ) {
    return undefined;
  }
  if (Number.isNaN(new Date(timestamp).getTime())) return undefined;
  return { event, id, payload, seq, timestamp };
}

// why: throws when the answer has no `events` list, so the view says it could not read it rather
// than showing nothing.
export function readReplay(body: unknown): readonly ConsoleEvent[] {
  const events = (body as { readonly events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new SyntaxError("The answer has no events list");
  return events.flatMap((data: unknown) => readEvent(data) ?? []);
}

// why: identity is the `id` alone, so an event seen twice, by the stream and by the `since` window,
// is shown once.
function keyOf(event: ConsoleEvent): string {
  return event.id;
}

// why: `seq` orders events inside the same millisecond.
function newestFirst(a: ConsoleEvent, b: ConsoleEvent): number {
  return b.timestamp - a.timestamp || b.seq - a.seq;
}

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

// why: rounded up, so the gap's first event is inside the window.
export function sinceFor(ms: number): string {
  return `${Math.ceil(ms / 1_000)}s`;
}

const SUBJECTS = ["lease", "device", "worker", "component"] as const;

export type Subject = (typeof SUBJECTS)[number] | "other";

export function subjectOf(name: string): Subject {
  const subject = name.split(".", 1)[0];
  return SUBJECTS.find((known) => known === subject) ?? "other";
}

// why: `worker.rejected` has no worker: its `workerId` is what a refused dial claimed, so it names
// no worker and shows only in the payload.
export function workerIdOf(event: ConsoleEvent): string | undefined {
  const { payload } = event;
  if (event.event === "worker.rejected" || typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const workerId = (payload as Record<string, unknown>).workerId;
  return typeof workerId === "string" ? workerId : undefined;
}

// why: a payload that is not an object shows as one pair, `payload`, so an unknown shape is still
// shown whole.
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

export function timeOfDay(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function textField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

// why: on a gateway an event belongs to a worker when its payload names it (a relayed event, or the
// gateway's own `worker.*`); a single host's events carry no worker id, since every one is the
// host's own, so all of them are the one worker's. Until the mode is known the gateway rule holds,
// which never shows an event that is not the worker's.
export function eventsOfWorker(
  events: readonly ConsoleEvent[],
  workerId: string,
  mode: "gateway" | "worker" | undefined,
): readonly ConsoleEvent[] {
  return events
    .filter((event) => mode === "worker" || workerIdOf(event) === workerId)
    .toSorted((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
}

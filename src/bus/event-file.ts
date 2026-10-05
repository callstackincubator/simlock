import { type Filesystem, isMissingPathError, type Logger, type LogSink } from "../ports/index.js";
import { EVENT_ID_PATTERN } from "../contract/schemas.js";
import type { EventBus, EventEnvelope, EventName } from "./index.js";
import { byTimeThenSeq } from "./order.js";

/** The durable record of every business event, in the data directory (ADR 0006). */
export const EVENT_FILE_NAME = "events.jsonl";

/**
 * Every envelope in the event file newer than `sinceTs`, by `timestamp` then `seq` (ADR 0014 §5).
 * The current file is read first, then its generations `<path>.1`, `<path>.2` and so on until
 * one is missing (ADR 0016 §4). Newest first means a rotation landing mid-read can only make a
 * generation show up twice -- never make one go missing -- and the repeat is dropped by `id`.
 * A rotation renames the generations one at a time, so for an instant one number is missing
 * with the ones above it still there: the walk ends only at a missing generation whose next
 * number is missing too. A line that is not JSON (a
 * write cut short by a crash), or has no `id` of the shape the envelope contract accepts
 * (written before events had one, ADR 0014), is skipped; a file that is not there is empty.
 */
export async function readEventFile(
  filesystem: Filesystem,
  path: string,
  options: { readonly sinceTs: number; readonly carry?: readonly EventName[] },
): Promise<EventEnvelope[]> {
  return (await readEventHistory(filesystem, path, options)).events;
}

/**
 * {@link readEventFile}, plus the oldest timestamp any kept generation holds -- not only what
 * is newer than `sinceTs` -- so a reader can say how far back the history reaches (ADR 0016 §5).
 * `undefined` when no event is held.
 */
export async function readEventHistory(
  filesystem: Filesystem,
  path: string,
  { sinceTs }: { readonly sinceTs: number; readonly carry?: readonly EventName[] },
): Promise<{ readonly events: EventEnvelope[]; readonly oldestTs: number | undefined }> {
  const generations = await readGenerations(filesystem, path);
  const seen = new Set<string>();
  const events: EventEnvelope[] = [];
  let oldestTs: number | undefined;
  // Oldest generation first, so events that tie on time and seq keep the order they were written.
  for (const line of generations.reverse().flat()) {
    const envelope = parseEnvelope(line);
    if (envelope === undefined) continue;
    oldestTs = Math.min(oldestTs ?? envelope.timestamp, envelope.timestamp);
    if (envelope.timestamp <= sinceTs || seen.has(eventKey(envelope))) continue;
    seen.add(eventKey(envelope));
    events.push(envelope);
  }
  return { events: events.sort(byTimeThenSeq), oldestTs };
}

/** The lines of the current file, then of each generation, newest first, until two in a row are missing. */
async function readGenerations(filesystem: Filesystem, path: string): Promise<string[][]> {
  const generations: string[][] = [];
  for (let generation = 0; ; generation += 1) {
    const lines = await readLines(filesystem, generation === 0 ? path : `${path}.${generation}`);
    if (lines !== undefined) generations.push(lines);
    // The current file may be missing while generations exist (a rotation caught between its
    // rename and its re-open). A missing generation is one rotation step caught mid-shift when
    // the next number exists; only two in a row end the walk.
    else if ((await readLines(filesystem, `${path}.${generation + 1}`)) === undefined) {
      return generations;
    }
  }
}

/** What identifies one event across the ring, the file and a live push: its `id` and nothing
 * else (ADR 0014). `seq` restarts with every daemon, so it never could. */
export function eventKey(event: { readonly id: string }): string {
  return event.id;
}

async function readLines(filesystem: Filesystem, path: string): Promise<string[] | undefined> {
  try {
    return (await filesystem.readFile(path)).split("\n");
  } catch (error: unknown) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function parseEnvelope(line: string): EventEnvelope | undefined {
  if (line.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { seq?: unknown }).seq !== "number" ||
    typeof (value as { timestamp?: unknown }).timestamp !== "number" ||
    typeof (value as { id?: unknown }).id !== "string" ||
    !EVENT_ID_PATTERN.test((value as { id: string }).id)
  ) {
    return undefined;
  }
  return value as EventEnvelope;
}

export interface EventHistoryOptions {
  readonly bus: EventBus;
  /** Where each event is written. Absent when the event file could not be opened. */
  readonly sink?: LogSink;
  readonly filesystem: Filesystem;
  /** The event file the sink writes, read back by `replay({ sinceTs })`. */
  readonly path: string;
  readonly logger: Logger;
}

/**
 * The bus's history: the in-memory ring for recent events, the event file for everything a
 * restart or the ring's capacity would otherwise lose. The writer is an observer (events rule
 * 5): a write that fails is logged once and writing stops, and nothing reaches the emitter.
 */
export class EventHistory {
  readonly #options: EventHistoryOptions;
  #writing: boolean;

  constructor(options: EventHistoryOptions) {
    this.#options = options;
    const { sink } = options;
    this.#writing = sink !== undefined;
    if (sink === undefined) return;
    options.bus.subscribeAll((envelope) => {
      if (!this.#writing) return;
      try {
        sink.write(JSON.stringify(envelope));
      } catch (error: unknown) {
        this.#writing = false;
        options.logger.error("Event file write failed; events are no longer written to it", {
          error: error instanceof Error ? error.message : String(error),
          path: options.path,
        });
      }
    });
  }

  /**
   * Without `sinceTs`, the ring, as `simlock events` has always answered. With it, the event
   * file while the writer is writing; the ring when there is no file to trust.
   */
  async replay(
    input: { readonly sinceTs?: number; readonly carry?: readonly EventName[] } = {},
  ): Promise<EventEnvelope[]> {
    const { bus, filesystem, logger, path } = this.#options;
    if (input.sinceTs === undefined) return bus.replay();
    if (!this.#writing) return bus.replay({ sinceTs: input.sinceTs });
    try {
      return await readEventFile(filesystem, path, { sinceTs: input.sinceTs });
    } catch (error: unknown) {
      logger.warn("Event file read failed; replaying from memory", {
        error: error instanceof Error ? error.message : String(error),
        path,
      });
      return bus.replay({ sinceTs: input.sinceTs });
    }
  }

  async read(_input: {
    readonly sinceTs: number;
    readonly carry: readonly EventName[];
  }): Promise<{ readonly events: EventEnvelope[]; readonly oldestTs: number | undefined }> {
    return { events: [], oldestTs: undefined };
  }

  latestId(): string | undefined {
    return undefined;
  }
}

import { type Filesystem, isMissingPathError, type Logger, type LogSink } from "../ports/index.js";
import { EVENT_ID_PATTERN } from "../contract/schemas.js";
import type { EventBus, EventEnvelope } from "./index.js";
import { byTimeThenSeq } from "./order.js";

/** The durable record of every business event, in the data directory (ADR 0006). */
export const EVENT_FILE_NAME = "events.jsonl";

/**
 * Every envelope in the event file newer than `sinceTs`, by `timestamp` then `seq` (ADR 0014 §5). The current file is
 * read before its rotated generation (`<path>.1`), so a rotation landing between the two reads
 * can only make one generation show up twice -- never make one go missing -- and the repeat is
 * dropped by `id`. A line that is not JSON (a write cut short by a crash), or has no `id` of the shape
 * the envelope contract accepts (written before events had one, ADR 0014), is skipped; a file that is not there is empty.
 */
export async function readEventFile(
  filesystem: Filesystem,
  path: string,
  { sinceTs }: { readonly sinceTs: number },
): Promise<EventEnvelope[]> {
  const current = await readLines(filesystem, path);
  const rotated = await readLines(filesystem, `${path}.1`);
  const seen = new Set<string>();
  const envelopes: EventEnvelope[] = [];
  for (const line of [...rotated, ...current]) {
    const envelope = parseEnvelope(line);
    if (envelope === undefined || envelope.timestamp <= sinceTs) continue;
    const key = eventKey(envelope);
    if (seen.has(key)) continue;
    seen.add(key);
    envelopes.push(envelope);
  }
  return envelopes.sort(byTimeThenSeq);
}

/** What identifies one event across the ring, the file and a live push: its `id` and nothing
 * else (ADR 0014). `seq` restarts with every daemon, so it never could. */
export function eventKey(event: { readonly id: string }): string {
  return event.id;
}

async function readLines(filesystem: Filesystem, path: string): Promise<string[]> {
  try {
    return (await filesystem.readFile(path)).split("\n");
  } catch (error: unknown) {
    if (isMissingPathError(error)) return [];
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
  async replay(input: { readonly sinceTs?: number } = {}): Promise<EventEnvelope[]> {
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
}

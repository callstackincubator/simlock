import type { EventEnvelope, EventName } from "../../bus/index.js";
import type { UsageOutput } from "../../contract/index.js";
import { computeUsage, seriesBucketMs, type UsageWindow } from "./compute-usage.js";

/** The two timelines whose step in force at a window's start is read with it (ADR 0016 §3). */
const STEP_EVENTS: readonly EventName[] = ["capacity.changed", "queue.changed"];

/** The part of the event history `usage.get` reads (`EventHistory` satisfies it). */
export interface UsageHistory {
  read(input: {
    readonly sinceTs: number;
    readonly carry: readonly EventName[];
  }): Promise<{ readonly events: readonly EventEnvelope[]; readonly oldestTs: number | undefined }>;
  /** The id of the event published last; the memo is good while it has not moved. */
  latestId(): string | undefined;
}

export interface UsageReaderOptions {
  readonly history: UsageHistory;
  /** Token id to label, from the store the answering daemon owns (ADR 0016 §7). */
  readonly tokenLabels: () => Promise<ReadonlyMap<string, string>>;
  /** The workers to report: a worker's own entry, a gateway's registry. Read on each answer. */
  readonly workers: () => readonly { readonly id: string; readonly label?: string | undefined }[];
  /** Set on a gateway: the figures are the fleet's (ADR 0016 §6), and this is the prefix it
   * stamps on the requesters it forwards (`gw:<instance>:`). */
  readonly fleet?: { readonly requesterPrefix: string };
}

/** What `get` answers: the figures, or how far back the history reaches when it is not far enough. */
export type UsageResult = { readonly usage: UsageOutput } | { readonly oldestTs: number };

/**
 * Answers `usage.get` for a worker or a gateway from the same code (ADR 0016): reads the history
 * for the window, hands it to `computeUsage`, joins token labels. The window is rounded out to the
 * series bucket, and the last answer is kept by that window and the newest event, so a caller that
 * asks again within the bucket while nothing happened reads nothing.
 */
export class UsageReader {
  #memo: { readonly key: string; readonly usage: UsageOutput } | undefined;

  constructor(private readonly options: UsageReaderOptions) {}

  async get(asked: UsageWindow): Promise<UsageResult> {
    const bucketMs = seriesBucketMs(asked.to - asked.from);
    // Out to the bucket on both sides, so the window asked for is inside the one answered.
    const window = {
      from: Math.floor(asked.from / bucketMs) * bucketMs,
      to: Math.ceil(asked.to / bucketMs) * bucketMs,
    };
    const key = `${window.from}:${window.to}:${String(this.options.history.latestId())}`;
    if (this.#memo?.key === key) return { usage: this.#memo.usage };

    const { events, oldestTs } = await this.options.history.read({
      carry: STEP_EVENTS,
      sinceTs: window.from,
    });
    if (oldestTs !== undefined && oldestTs > asked.to) return { oldestTs };
    const usage = computeUsage(events, window, {
      fleet: this.options.fleet !== undefined,
      labels: await this.#labelsFor(events),
      oldestTs,
      requesterPrefix: this.options.fleet?.requesterPrefix ?? "",
      workers: this.options.workers(),
    });
    this.#memo = { key, usage };
    return { usage };
  }

  /** The label of each requester the events name that the token store knows (ADR 0016 §7). */
  async #labelsFor(events: readonly EventEnvelope[]): Promise<Record<string, string>> {
    const prefix = this.options.fleet?.requesterPrefix;
    const requesters = requestersIn(events);
    if (requesters.size === 0) return {};
    const tokens = await this.options.tokenLabels();
    const labels: Record<string, string> = {};
    for (const requester of requesters) {
      const own = prefix !== undefined && requester.startsWith(prefix);
      const label = tokens.get(own ? requester.slice(prefix.length) : requester);
      if (label !== undefined) labels[requester] = label;
    }
    return labels;
  }
}

/** Every requester id the events name, as a request, a rejection or a dispatch has it. */
function requestersIn(events: readonly EventEnvelope[]): Set<string> {
  const requesters = new Set<string>();
  for (const event of events) {
    const payload = event.payload as {
      readonly requester?: unknown;
      readonly requesterId?: unknown;
    };
    for (const requester of [payload.requester, payload.requesterId]) {
      if (typeof requester === "string") requesters.add(requester);
    }
  }
  return requesters;
}

/** The labelled tokens of a store as the reader takes them: token id to label. */
export function tokenLabelMap(
  tokens: readonly { readonly id: string; readonly label?: string | undefined }[],
): Map<string, string> {
  return new Map(
    tokens.flatMap((token) => (token.label === undefined ? [] : [[token.id, token.label]])),
  );
}

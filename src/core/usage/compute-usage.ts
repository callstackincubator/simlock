import type { EventEnvelope } from "../../bus/index.js";
import type { UsageFigures, UsageOutput } from "../../contract/index.js";

export interface UsageWindow {
  readonly from: number;
  readonly to: number;
}

export interface UsageOptions {
  readonly fleet: boolean;
  readonly labels?: Readonly<Record<string, string>>;
  readonly requesterPrefix?: string;
  readonly workerId?: string;
  readonly workerLabels?: Readonly<Record<string, string>>;
  readonly oldestTs?: number;
}

const NO_SAMPLES = { count: 0, max: null, p50: null, p95: null };

function emptyFigures(): UsageFigures {
  return {
    boot: NO_SAMPLES,
    bySource: { booted: 0, provisioned: 0, warm: 0 },
    errors: { byCode: {} },
    granted: 0,
    held: NO_SAMPLES,
    incidents: { crashRecovered: 0, lost: 0, quarantineRecovered: 0, quarantined: 0 },
    provisioning: NO_SAMPLES,
    queue: { meanDepth: null, peakDepth: null },
    rejected: { byReason: {}, total: 0 },
    requests: 0,
    turnaround: NO_SAMPLES,
    utilisation: { slots: { max: null, mean: null, peak: null } },
    wait: NO_SAMPLES,
  };
}

/** The series bucket width for a window of `spanMs` (ADR 0016 §8). */
export function seriesBucketMs(_spanMs: number): number {
  return 60_000;
}

export function computeUsage(
  _events: readonly EventEnvelope[],
  window: UsageWindow,
  _options: UsageOptions,
): UsageOutput {
  return {
    bucketMs: 60_000,
    coversFrom: window.from,
    partial: false,
    platforms: { android: emptyFigures(), ios: emptyFigures() },
    requesters: [],
    series: [],
    totals: emptyFigures(),
    window,
    workers: [],
  };
}

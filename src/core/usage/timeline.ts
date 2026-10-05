/**
 * Step functions over time (ADR 0016 §3): each key (a worker, or the one queue) holds its latest
 * value until it steps. The window's start is told by the step in force there, which is the last
 * one at or before it; where there is none, the time before the first step is unknown, not zero.
 */
export interface Step<Value> {
  readonly at: number;
  readonly key: string;
  readonly value: Value;
}

export interface Segment<Value> {
  readonly start: number;
  readonly end: number;
  /** The value each key holds throughout the segment; empty before any key has stepped. */
  readonly values: readonly Value[];
}

/** The segments of `[from, to]`, one for each stretch between steps. `steps` is in time order. */
export function segmentsOf<Value>(
  steps: readonly Step<Value>[],
  from: number,
  to: number,
): Segment<Value>[] {
  const current = new Map<string, Value>();
  let index = 0;
  for (; index < steps.length && (steps[index] as Step<Value>).at <= from; index += 1) {
    const step = steps[index] as Step<Value>;
    current.set(step.key, step.value);
  }
  const segments: Segment<Value>[] = [];
  let start = from;
  for (; index < steps.length; index += 1) {
    const step = steps[index] as Step<Value>;
    if (step.at >= to) break;
    segments.push({ end: step.at, start, values: [...current.values()] });
    current.set(step.key, step.value);
    start = step.at;
  }
  segments.push({ end: to, start, values: [...current.values()] });
  return segments;
}

/** The values in force at each of `times`, which ascend. A step at a time is already in force. */
export function valuesAt<Value>(
  steps: readonly Step<Value>[],
  times: readonly number[],
): (readonly Value[])[] {
  const current = new Map<string, Value>();
  let index = 0;
  return times.map((time) => {
    for (; index < steps.length && (steps[index] as Step<Value>).at <= time; index += 1) {
      const step = steps[index] as Step<Value>;
      current.set(step.key, step.value);
    }
    return [...current.values()];
  });
}

/**
 * The peak and the time-weighted mean of what `read` takes from each segment, over the stretches
 * where it is known. `undefined` when no stretch with time in it is known.
 */
export function peakAndMean<Value>(
  segments: readonly Segment<Value>[],
  read: (values: readonly Value[]) => number | undefined,
): { readonly peak: number; readonly mean: number } | undefined {
  let peak: number | undefined;
  let weighted = 0;
  let known = 0;
  for (const segment of segments) {
    const duration = segment.end - segment.start;
    if (duration <= 0) continue;
    const value = read(segment.values);
    if (value === undefined) continue;
    peak = Math.max(peak ?? value, value);
    weighted += value * duration;
    known += duration;
  }
  return peak === undefined ? undefined : { mean: weighted / known, peak };
}

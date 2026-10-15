import type { Tone } from "./status";

// why: the worker sends no thresholds, so the CPU and disk gauges would have nothing to be
// coloured by. These are the console's own opinion, read off the one figure each gauge is drawn
// from; nothing here is remembered between readings, so a bar always shows the current reading's
// verdict. `simlock status` reports the same figures without one.
export const LOAD_THRESHOLDS = { errorPercent: 95, warnPercent: 85 } as const;

// why: below `warnPercent` a figure stays in the neutral tone, so a colour always says a threshold
// was crossed rather than "healthy, as far as we guessed". A figure the reading does not carry has
// nothing to judge.
export function levelOf(percent: number | undefined): Tone {
  if (percent === undefined) return "idle";
  if (percent >= LOAD_THRESHOLDS.errorPercent) return "error";
  if (percent >= LOAD_THRESHOLDS.warnPercent) return "warn";
  return "idle";
}

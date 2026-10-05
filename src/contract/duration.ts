const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * The one parser for the durations a person types (`500`, `2s`, `3m`, `1h`, `7d`) -- the CLI
 * and the HTTP API both call it, so a unit is accepted on every surface or on none. A bare
 * number is milliseconds. `undefined` when the text is not a duration or overflows a safe
 * integer; each caller raises its own error for that.
 */
export function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value);
  if (match === null) return undefined;
  const [, amount = "", unit = "ms"] = match;
  const multiplier = UNIT_MS[unit];
  if (multiplier === undefined) return undefined;
  const milliseconds = Number(amount) * multiplier;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

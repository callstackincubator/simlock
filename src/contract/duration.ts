const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/**
 * The one parser for the durations a person types (`500`, `2s`, `3m`, `1h`, `7d`) -- the CLI
 * and the HTTP API both call it, so a unit is accepted on every surface or on none. A bare
 * number is milliseconds. `undefined` when the text is not a duration or overflows a safe
 * integer; each caller raises its own error for that.
 */
export function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value);
  if (match === null) return undefined;
  // The pattern admits only the units in UNIT_MS, and only matches with an amount.
  const [, amount, unit = "ms"] = match as unknown as [
    string,
    string,
    keyof typeof UNIT_MS | undefined,
  ];
  const milliseconds = Number(amount) * UNIT_MS[unit];
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

import { UsageError } from "./errors.js";

/** Parses user-facing durations only at the CLI boundary. */
export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (match === null) throw new UsageError(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new UsageError(`Invalid duration: ${value}`);
  return milliseconds;
}

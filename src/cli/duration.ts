// why: kept out of the router's own load -- the contract barrel behind `parseDurationMs`
// carries zod, and a command that parses a duration pays for that anyway.
import { parseDurationMs } from "../contract/index.js";
import { UsageError } from "./errors.js";

export function parseDuration(value: string): number {
  const milliseconds = parseDurationMs(value);
  if (milliseconds === undefined) throw new UsageError(`Invalid duration: ${value}`);
  return milliseconds;
}

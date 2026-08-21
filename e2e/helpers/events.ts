import { cli } from "./cli.js";
import { waitFor } from "./wait.js";

export interface RecordedEvent {
  readonly timestamp: number;
  readonly event: string;
  readonly payload: unknown;
  readonly module: string;
}

/** Replays the business-event ring buffer via `simlock events --since`, parsed. */
export async function events(env: NodeJS.ProcessEnv, since = "1h"): Promise<RecordedEvent[]> {
  const result = await cli(["events", "--since", since], env);
  if (result.code !== 0) {
    throw new Error(`simlock events failed (exit ${String(result.code)}): ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/**
 * Asserts that `expectedNames` appear, in order, as a (not necessarily contiguous)
 * subsequence of the recorded event names -- this is what "the documented sequence"
 * checks in the flows mean: the daemon did these things in this order, extra events
 * from unrelated activity are fine.
 */
export async function expectEvents(
  env: NodeJS.ProcessEnv,
  expectedNames: readonly string[],
  options: { readonly since?: string; readonly timeout?: number } = {},
): Promise<RecordedEvent[]> {
  let recorded: RecordedEvent[] = [];
  await waitFor(
    async () => {
      recorded = await events(env, options.since);
      return containsOrderedSubsequence(
        recorded.map((entry) => entry.event),
        expectedNames,
      );
    },
    {
      timeout: options.timeout ?? 15_000,
      label: () =>
        `expected event sequence [${expectedNames.join(", ")}], last saw [${recorded
          .map((entry) => entry.event)
          .join(", ")}]`,
    },
  );
  return recorded;
}

function containsOrderedSubsequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  let index = 0;
  for (const name of haystack) {
    if (index >= needle.length) break;
    if (name === needle[index]) index += 1;
  }
  return index === needle.length;
}

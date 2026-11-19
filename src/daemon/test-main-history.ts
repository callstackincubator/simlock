import { expect, vi } from "vitest";
import { type EventEnvelope } from "../bus/index.js";
import { readHistoryEvents } from "../history/testing.js";

export async function historyEventsWhen(
  directory: string,
  done: (events: readonly EventEnvelope[]) => boolean,
): Promise<EventEnvelope[]> {
  let events: EventEnvelope[] = [];
  await vi.waitFor(
    async () => {
      events = await readHistoryEvents(directory);
      expect(done(events)).toBe(true);
    },
    { timeout: 4_000 },
  );
  return events;
}

export const hasEvent =
  (name: string) =>
  (events: readonly EventEnvelope[]): boolean =>
    events.some((event) => event.event === name);

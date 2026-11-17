import { type ConsoleEvent, textField, workerIdOf } from "./events";
import { eventsOfLease } from "./leases";

// why: the page's feed is the device's own story: events that name the device (on a gateway, on the
// worker the page is about) and those of the lease that holds it, newest first, each once.
export function eventsOfDevice(
  events: readonly ConsoleEvent[],
  workerId: string,
  deviceId: string,
  leaseId: string | undefined,
): readonly ConsoleEvent[] {
  const byLease = leaseId === undefined ? [] : eventsOfLease(events, leaseId);
  const own = events.filter((event) => {
    if (textField(event.payload, "deviceId") !== deviceId) return false;
    const named = workerIdOf(event);
    return named === undefined || named === workerId;
  });
  const seen = new Set<string>();
  return [...own, ...byLease]
    .filter((event) => !seen.has(event.id) && seen.add(event.id))
    .toSorted((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
}

// why: a row reads "Lease granted" where the feed's own name is `lease.granted`.
export function eventTitle(name: string): string {
  const text = name.replaceAll(".", " ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a worker's `NO_CAPACITY` refusal is remembered against (ADR 0009 §5): the part of its
 * view that decides whether it can take one more request. A refusal holds while this key is
 * unchanged, so it leaves out what changes on every read -- `lastSeenAt` on the view and
 * `transitionAgeMs` on each device -- or the memo would never hold.
 */
import type { WorkerView } from "../worker-registry.js";

export function viewLoadKey(view: WorkerView): string {
  return canonicalJson({
    capacity: view.capacity,
    devices: view.devices.map(({ transitionAgeMs: _transitionAgeMs, ...device }) => device),
    health: view.health,
    leases: view.leases.map((lease) => lease.id),
    queueDepth: view.queueDepth,
  });
}

/** JSON with object keys sorted, so two views built in a different field order agree. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : 1)),
        )
      : nested,
  );
}

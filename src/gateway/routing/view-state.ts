/**
 * A refusal holds while this key is unchanged, so it leaves out what changes on every read
 * (`lastSeenAt`, `transitionAgeMs`), or the memo would never hold.
 */
import type { WorkerView } from "../worker-registry.js";

export function viewLoadKey(view: WorkerView): string {
  return canonicalJson({
    capacity: view.capacity,
    devices: (view.devices ?? []).map(({ transitionAgeMs: _transitionAgeMs, ...device }) => device),
    health: view.health,
    leases: (view.leases ?? []).map((lease) => lease.id),
    physicalQueueDepth: view.physicalQueueDepth,
    queueDepth: view.queueDepth,
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : 1)),
        )
      : nested,
  );
}

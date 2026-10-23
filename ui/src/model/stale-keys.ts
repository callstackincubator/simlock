// why: a key is the front of a query key; `["lease"]` stands for every `["lease", id]`.
export type StaleKey = readonly string[];

const LEASES: readonly StaleKey[] = [["leases"], ["workers"], ["lease"]];
const REQUESTS: readonly StaleKey[] = [["lease-requests"]];
const WORKERS: readonly StaleKey[] = [["workers"]];
const NONE: readonly StaleKey[] = [];

function hasLeaseId(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return typeof (payload as { readonly leaseId?: unknown }).leaseId === "string";
}

// why: the data an event changes is stale from then on; a renewal changes only a deadline, which
// the console takes from the event itself, and any name not listed changes nothing a page shows.
export function staleKeys(name: string, payload: unknown): readonly StaleKey[] {
  switch (name) {
    case "lease.granted":
    case "lease.released":
    case "lease.expired":
      return LEASES;
    case "lease.requested":
    case "lease.queued":
    case "lease.rejected":
    case "lease.declined":
    case "queue.changed":
      return REQUESTS;
    case "capacity.changed":
      return WORKERS;
    default:
  }
  if (name.startsWith("request.")) return REQUESTS;
  if (name.startsWith("device.")) return hasLeaseId(payload) ? [["workers"], ["lease"]] : WORKERS;
  if (
    name.startsWith("worker.") ||
    name.startsWith("component.") ||
    name.startsWith("daemon.update-")
  ) {
    return WORKERS;
  }
  return NONE;
}

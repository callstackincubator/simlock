// why: a key is the front of a query key; `["lease"]` stands for every `["lease", id]`.
export type StaleKey = readonly string[];

// why: the Inbox is made from the workers, leases and waiting requests, so whatever marks one of them marks it.
const LEASES: readonly StaleKey[] = [["leases"], ["workers"], ["lease"], ["inbox"]];
const REQUESTS: readonly StaleKey[] = [["lease-requests"], ["inbox"]];
const WORKERS: readonly StaleKey[] = [["workers"], ["inbox"]];
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
  if (name.startsWith("device."))
    return hasLeaseId(payload) ? [["workers"], ["lease"], ["inbox"]] : WORKERS;
  if (
    name.startsWith("worker.") ||
    name.startsWith("component.") ||
    name.startsWith("daemon.update-")
  ) {
    return WORKERS;
  }
  return NONE;
}

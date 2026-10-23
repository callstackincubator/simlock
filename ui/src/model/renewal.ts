import type { ConsoleEvent } from "./events";
import type { LeaseList, LeaseRecord } from "./leases";
import type { WorkerList } from "./workers";

export interface Renewal {
  readonly leaseId: string;
  readonly newDeadline: number;
  readonly timestamp: number;
  // why: set by a gateway, which relays the worker's own lease id.
  readonly workerId?: string;
}

// why: the payload is wire input, so a renewal missing either field is dropped rather than patched
// from a guess.
export function readRenewal(event: ConsoleEvent): Renewal | undefined {
  if (event.event !== "lease.renewed") return undefined;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const { leaseId, newDeadline, workerId } = payload as Record<string, unknown>;
  if (typeof leaseId !== "string" || typeof newDeadline !== "number") return undefined;
  return {
    leaseId,
    newDeadline,
    timestamp: event.timestamp,
    ...(typeof workerId === "string" ? { workerId } : {}),
  };
}

// why: a gateway's lease list names a lease by `<worker>.<worker's id>` unless the requester chose
// the id, so its record is found by the worker and the worker's own id; a worker's records carry the id the event names.
function isRenewed(lease: LeaseRecord, renewal: Renewal): boolean {
  return renewal.workerId === undefined
    ? lease.id === renewal.leaseId
    : lease.workerId === renewal.workerId && lease.workerLeaseId === renewal.leaseId;
}

function renewLease(
  lease: LeaseRecord,
  renewal: Renewal,
  matches: (lease: LeaseRecord) => boolean,
): LeaseRecord {
  if (!matches(lease) || renewal.newDeadline <= lease.ttlDeadline) return lease;
  return {
    ...lease,
    lastRenewedAt: renewal.timestamp,
    ttlDeadline: renewal.newDeadline,
    ttlMs: renewal.newDeadline - renewal.timestamp,
  };
}

// why: the same list when no lease changed, so an observer of it is not told of an update.
function renewLeases(list: LeaseList, renewal: Renewal): LeaseList {
  const leases = list.leases.map((lease) =>
    renewLease(lease, renewal, (candidate) => isRenewed(candidate, renewal)),
  );
  return leases.some((lease, index) => lease !== list.leases[index]) ? { ...list, leases } : list;
}

// why: a worker's own page lists leases under their worker, by the worker's own lease id.
function renewWorkers(list: WorkerList, renewal: Renewal): WorkerList {
  const workers = list.workers.map((worker) => {
    if (worker.leases === undefined) return worker;
    if (renewal.workerId !== undefined && worker.id !== renewal.workerId) return worker;
    const leases = worker.leases.map((lease) =>
      renewLease(lease, renewal, (candidate) => candidate.id === renewal.leaseId),
    );
    return leases.some((lease, index) => lease !== worker.leases?.[index])
      ? { ...worker, leases }
      : worker;
  });
  return workers.some((worker, index) => worker !== list.workers[index])
    ? { ...list, workers }
    : list;
}

// why: the routes whose answers carry leases, each patched by its own match rule.
export function renewAnswer<T>(route: string, data: T, renewal: Renewal): T {
  if (route === "leases") return renewLeases(data as LeaseList, renewal) as T;
  if (route === "workers") return renewWorkers(data as WorkerList, renewal) as T;
  return data;
}

// why: the Inbox shows a lease's time left only on its `ending` item, the only item that embeds a lease.
export function endsInInbox(data: unknown, renewal: Renewal): boolean {
  const items = (data as { readonly items?: readonly unknown[] } | undefined)?.items;
  return (items ?? []).some((item) => {
    const { lease } = item as { lease?: LeaseRecord };
    return lease !== undefined && isRenewed(lease, renewal);
  });
}

// why: a gateway routes a lease under `<worker>.<worker's id>`, or under the bare id its requester
// chose; the lease list says which, and an unlisted lease is taken as prefixed.
export function leaseKeyOf(renewal: Renewal, leases: unknown): readonly string[] {
  if (renewal.workerId === undefined) return ["lease", renewal.leaseId];
  const listed = (leases as LeaseList | undefined)?.leases?.find((lease) =>
    isRenewed(lease, renewal),
  );
  return ["lease", listed?.id ?? `${renewal.workerId}.${renewal.leaseId}`];
}

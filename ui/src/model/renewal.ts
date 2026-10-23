import type { ConsoleEvent } from "./events";
import type { LeaseList, LeaseRecord } from "./leases";

export interface Renewal {
  readonly leaseId: string;
  readonly newDeadline: number;
  readonly timestamp: number;
}

// why: the payload is wire input, so a renewal missing either field is dropped rather than patched
// from a guess.
export function readRenewal(event: ConsoleEvent): Renewal | undefined {
  if (event.event !== "lease.renewed") return undefined;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const { leaseId, newDeadline } = payload as Record<string, unknown>;
  if (typeof leaseId !== "string" || typeof newDeadline !== "number") return undefined;
  return { leaseId, newDeadline, timestamp: event.timestamp };
}

function renewLease(lease: LeaseRecord, renewal: Renewal): LeaseRecord {
  if (lease.id !== renewal.leaseId || renewal.newDeadline <= lease.ttlDeadline) return lease;
  return {
    ...lease,
    lastRenewedAt: renewal.timestamp,
    ttlDeadline: renewal.newDeadline,
    ttlMs: renewal.newDeadline - renewal.timestamp,
  };
}

// why: the same list when no lease changed, so an observer of it is not told of an update.
export function renewLeases(list: LeaseList, renewal: Renewal): LeaseList {
  const leases = list.leases.map((lease) => renewLease(lease, renewal));
  return leases.some((lease, index) => lease !== list.leases[index]) ? { ...list, leases } : list;
}

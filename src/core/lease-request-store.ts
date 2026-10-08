import type { IdGenerator } from "../ports/index.js";
import { isSettled, type LeaseRequestFailure, type LeaseRequestRecord } from "./domain.js";
import type { DeviceRequest } from "./driver.js";

/** `lease.requestRetentionMs` and `lease.maxRequestRecords`, as a store applies them. */
export interface LeaseRequestLimits {
  readonly retentionMs: number;
  readonly maxRecords: number;
}

/** The one place a lease request's id is minted. */
export function newLeaseRequestId(idGenerator: IdGenerator): string {
  return `req_${idGenerator.generate()}`;
}

export interface NewLeaseRequest {
  /** The id the record is stored under, when the caller minted it before admission checks. */
  readonly id?: string | undefined;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly idempotencyKey?: string;
  readonly leaseId?: string;
  readonly request: DeviceRequest;
}

export type LeaseRequestOutcome<Grant> =
  | { readonly state: "granted"; readonly grant: Grant }
  | { readonly state: "failed"; readonly failure: LeaseRequestFailure }
  | { readonly state: "cancelled" };

/**
 * Where lease-request records live. The daemon's `Registry` keeps them in `state.json`; a
 * gateway keeps them in memory (`InMemoryLeaseRequestStore`). Both apply retention, the record
 * cap, and settlement through the functions below, so the two cannot disagree about them.
 */
export interface LeaseRequestStore<Grant> {
  /** Every record still inside its retention window, oldest first. */
  leaseRequests(): readonly LeaseRequestRecord<Grant>[];
  createLeaseRequest(input: NewLeaseRequest): Promise<LeaseRequestRecord<Grant>>;
  /** Writes a result onto an open record. A record that is already settled, or gone, is left alone. */
  settleLeaseRequest(
    id: string,
    outcome: LeaseRequestOutcome<Grant>,
  ): Promise<LeaseRequestRecord<Grant> | undefined>;
}

/** An open record is always retained; a settled one only until `retentionMs` after it settled. */
export function retainedLeaseRequests<Grant>(
  records: readonly LeaseRequestRecord<Grant>[],
  now: number,
  retentionMs: number,
): LeaseRequestRecord<Grant>[] {
  return records.filter(
    (record) => !isSettled(record) || (record.settledAt ?? now) + retentionMs > now,
  );
}

/**
 * Appends `record` after pruning expired records and, while the list is at the cap, evicting the
 * oldest settled one. An open record is never evicted: when every record is open the new one is
 * still admitted, because refusing it would turn the cap into an outage rather than a bound.
 */
export function withNewLeaseRequest<Grant>(
  records: readonly LeaseRequestRecord<Grant>[],
  record: LeaseRequestRecord<Grant>,
  now: number,
  limits: LeaseRequestLimits,
): LeaseRequestRecord<Grant>[] {
  const kept = retainedLeaseRequests(records, now, limits.retentionMs);
  while (kept.length >= limits.maxRecords) {
    const oldestSettled = kept.findIndex((candidate) => isSettled(candidate));
    if (oldestSettled === -1) break;
    kept.splice(oldestSettled, 1);
  }
  return [...kept, record];
}

export function withSettledLeaseRequest<Grant>(
  records: readonly LeaseRequestRecord<Grant>[],
  id: string,
  outcome: LeaseRequestOutcome<Grant>,
  now: number,
): {
  readonly records: readonly LeaseRequestRecord<Grant>[];
  readonly settled?: LeaseRequestRecord<Grant>;
} {
  const index = records.findIndex((record) => record.id === id);
  const open = records[index];
  if (open === undefined || isSettled(open)) return { records };
  const settled: LeaseRequestRecord<Grant> = { ...open, ...outcome, settledAt: now };
  const next = [...records];
  next[index] = settled;
  return { records: next, settled };
}

export function newLeaseRequestRecord<Grant>(
  id: string,
  input: NewLeaseRequest,
  now: number,
): LeaseRequestRecord<Grant> {
  return {
    createdAt: now,
    id,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
    ownerId: input.ownerId,
    request: { ...input.request },
    requesterId: input.requesterId,
    state: "open",
  };
}

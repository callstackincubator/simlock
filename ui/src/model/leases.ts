import type { z } from "zod";

import type { statusLeaseSchema, tokenRecordSchema } from "../../../src/contract/schemas";
import type { Stat } from "./stat";
import { type WorkerDevice, type WorkerView, workerName } from "./workers";

export type LeaseRecord = z.infer<typeof statusLeaseSchema>;

export interface LeaseList {
  readonly leases: readonly LeaseRecord[];
}

export type TokenRecord = z.infer<typeof tokenRecordSchema>;

export interface TokenList {
  readonly tokens: readonly TokenRecord[];
}

export interface LeaseDetails {
  readonly id: string;
  readonly requestId?: string;
  readonly device: string;
  readonly udid: string;
  readonly deviceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  // why: a lease on a physical device has no mode.
  readonly mode?: string;
  readonly imageTag?: string;
  readonly workerId?: string;
  readonly worker?: { readonly id: string; readonly label?: string };
}

export interface Holder {
  readonly id: string;
  readonly label?: string;
}

// why: over HTTP a requester's id is its token's id, so a token with that id names it; a requester
// no token matches, such as an agent on the local socket, is its id alone.
export function holderOf(requesterId: string, tokens: readonly TokenRecord[]): Holder {
  const label = tokens.find((token) => token.id === requesterId)?.label;
  return label === undefined ? { id: requesterId } : { id: requesterId, label };
}

// why: a single host names no worker on its leases, and every lease there is on its one worker, the
// host itself.
export function workerOfLease(
  lease: { readonly workerId?: string | undefined },
  workers: readonly WorkerView[],
): WorkerView | undefined {
  if (lease.workerId === undefined) return workers.length === 1 ? workers[0] : undefined;
  return workers.find((worker) => worker.id === lease.workerId);
}

export function leasesOnWorker(
  leases: readonly LeaseRecord[],
  workerId: string,
  workers: readonly WorkerView[],
): readonly LeaseRecord[] {
  return leases.filter((lease) => workerOfLease(lease, workers)?.id === workerId);
}

// why: `GET /v1/leases` promises no order, so the console sets its own from facts a lease keeps for
// life, and a refresh moves no lease to another page.
export function inGrantOrder(leases: readonly LeaseRecord[]): readonly LeaseRecord[] {
  return [...leases].sort(
    (a, b) =>
      a.grantedAt - b.grantedAt ||
      compare(a.workerId ?? "", b.workerId ?? "") ||
      compare(a.id, b.id),
  );
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function deviceOfLease(
  lease: LeaseRecord,
  workers: readonly WorkerView[],
): WorkerDevice | undefined {
  return workerOfLease(lease, workers)?.devices?.find((device) => device.id === lease.deviceId);
}

export function workerNameOfLease(
  lease: {
    readonly workerId?: string | undefined;
    readonly worker?: { readonly label?: string | undefined } | undefined;
  },
  workers: readonly WorkerView[],
): string | undefined {
  const worker = workerOfLease(lease, workers);
  if (worker !== undefined) return workerName(worker);
  return lease.worker?.label ?? lease.workerId;
}

// why: a gateway's lease id holds a `.`, and the daemon serves the console's page only for a path
// whose last segment has none, so the path ends in `/`.
export function leasePath(id: string): `/${string}` {
  return `/leases/${encodeURIComponent(id)}/`;
}

const EXPIRING_WITHIN_MS = 15 * 60_000;

export function leasesStats(leases: readonly LeaseRecord[], now: number): readonly Stat[] {
  const holders = new Set(leases.map((lease) => lease.requesterId));
  const expiring = leases.filter((lease) => lease.ttlDeadline - now <= EXPIRING_WITHIN_MS);
  return [
    { caption: "held now", label: "Leases", value: String(leases.length) },
    { caption: "holding at least one lease", label: "Holders", value: String(holders.size) },
    {
      caption: "expire within 15 minutes unless renewed",
      label: "Expiring soon",
      value: String(expiring.length),
    },
  ];
}

export function leaseIdFrom(path: string): string | undefined {
  const rest = path.replace(/^\/leases\/?/, "").replace(/\/$/, "");
  if (rest === "") return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

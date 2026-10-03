/**
 * The facts the leases views show, computed from `GET /v1/leases`, `GET /v1/tokens`,
 * `GET /v1/workers` and, for one lease, `GET /v1/leases/{id}` (ADR 0013 §1). Pure, so the views
 * stay rendering and these stay tested. The types are the contract's where it has them, imported
 * type-only (ADR 0011 §1); every value is still a claim, so a fact the data lacks shows as
 * missing rather than guessed.
 */
import type { z } from "zod";

import type { statusLeaseSchema, tokenRecordSchema } from "../../../src/contract/schemas";
import type { Stat } from "../layout";
import { type WorkerDevice, type WorkerView, workerName } from "./workers-model";

/** One lease as `GET /v1/leases` lists it. `workerId` is set on a gateway and absent on a host. */
export type LeaseRecord = z.infer<typeof statusLeaseSchema>;

export interface LeaseList {
  readonly leases: readonly LeaseRecord[];
}

export type TokenRecord = z.infer<typeof tokenRecordSchema>;

export interface TokenList {
  readonly tokens: readonly TokenRecord[];
}

/** The fields of `GET /v1/leases/{id}`'s lease that the details page reads. */
export interface LeaseDetails {
  readonly id: string;
  readonly requestId?: string;
  readonly device: string;
  readonly udid: string;
  readonly deviceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly mode: string;
  readonly imageTag?: string;
  readonly workerId?: string;
  readonly worker?: { readonly id: string; readonly label?: string };
}

/** Who holds a lease: its token's label when a token has the requester's id, and the id. */
export interface Holder {
  readonly id: string;
  readonly label?: string;
}

/**
 * The holder of a lease taken with `requesterId`. Over HTTP a requester's id is its token's id,
 * so a token with that id names it. A requester no token matches, such as an agent that leased
 * over the local socket, is its id alone.
 */
export function holderOf(requesterId: string, tokens: readonly TokenRecord[]): Holder {
  const label = tokens.find((token) => token.id === requesterId)?.label;
  return label === undefined ? { id: requesterId } : { id: requesterId, label };
}

/**
 * The worker a lease lives on. A gateway names it on every lease it lists; a single host names
 * none, and every lease there is on its one worker, the host itself.
 */
export function workerOfLease(
  lease: { readonly workerId?: string | undefined },
  workers: readonly WorkerView[],
): WorkerView | undefined {
  if (lease.workerId === undefined) return workers.length === 1 ? workers[0] : undefined;
  return workers.find((worker) => worker.id === lease.workerId);
}

/** The leases on one worker, by the same rule `workerOfLease` names a lease's worker. */
export function leasesOnWorker(
  leases: readonly LeaseRecord[],
  workerId: string,
  workers: readonly WorkerView[],
): readonly LeaseRecord[] {
  return leases.filter((lease) => workerOfLease(lease, workers)?.id === workerId);
}

/**
 * The leases oldest granted first, by the worker's id and the lease's own id where two were
 * granted in the same millisecond. `GET /v1/leases` promises no order, so the console sets its
 * own from facts a lease keeps for life, and a refresh moves no lease to another page.
 */
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

/** The device a lease holds, as its worker reports it. A device id is matched on its own worker. */
export function deviceOfLease(
  lease: LeaseRecord,
  workers: readonly WorkerView[],
): WorkerDevice | undefined {
  return workerOfLease(lease, workers)?.devices.find((device) => device.id === lease.deviceId);
}

/** The name of the worker a lease lives on: its label, else its id, else `undefined`. */
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

/**
 * A lease's page. A gateway's lease id holds a `.`, and the daemon serves the console's page only
 * for a path whose last segment has none, so the page's path ends in `/`: a reload, or a pasted
 * link, still lands on it.
 */
export function leasePath(id: string): `/${string}` {
  return `/leases/${encodeURIComponent(id)}/`;
}

/** How soon a lease expires for the Leases view to count it as expiring. */
const EXPIRING_WITHIN_MS = 15 * 60_000;

/**
 * The Leases view's stat cards: how many leases, how many holders hold them, and how many
 * expire within 15 minutes of the daemon's `now` unless they are renewed.
 */
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

/** The lease id a page path names, or `undefined` for the list (`/leases`). */
export function leaseIdFrom(path: string): string | undefined {
  const rest = path.replace(/^\/leases\/?/, "").replace(/\/$/, "");
  if (rest === "") return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

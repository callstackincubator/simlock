import type { z } from "zod";

import type { statusLeaseSchema, tokenRecordSchema } from "../../../src/contract/schemas";
import { defined } from "./defined";
import { type ConsoleEvent, textField, workerIdOf } from "./events";
import { formatDuration } from "./time";
import { type WorkerDevice, type WorkerView, workerName, workerPath } from "./workers";

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
  const id = agentIdOf(requesterId);
  const label = tokens.find((token) => token.id === id)?.label;
  return label === undefined ? { id } : { id, label };
}

const GATEWAY_REQUESTER = /^gw:[^:]+:(.+)$/;

// why: a gateway hands a worker its agents' requests under `gw:<gateway instance>:<agent id>`, so a
// worker's own view names the agent behind that prefix; the console shows the agent, as the
// gateway's lease list does.
export function agentIdOf(requesterId: string): string {
  return GATEWAY_REQUESTER.exec(requesterId)?.[1] ?? requesterId;
}

// why: a holder's title is its token's label, or its id where no label names it.
function holderTitle(holder: Holder): string {
  return holder.label ?? holder.id;
}

export function holderName(requesterId: string, tokens: readonly TokenRecord[]): string {
  return holderTitle(holderOf(requesterId, tokens));
}

// why: a single host names no worker on its leases, and every lease there is on its one worker, the
// host itself.
function workerOfLease(
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
function inGrantOrder(leases: readonly LeaseRecord[]): readonly LeaseRecord[] {
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

function workerNameOfLease(
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

export type LeaseFilter = "all" | "expiring" | "ios" | "android";

export const LEASE_FILTERS: readonly { readonly value: LeaseFilter; readonly label: string }[] = [
  { label: "All", value: "all" },
  { label: "Ending < 5 min", value: "expiring" },
  { label: "iOS", value: "ios" },
  { label: "Android", value: "android" },
];

// why: a lease with under 5 minutes left is about to end, so the list, the lease drawer, the Overview and the
// Inbox warn by the same rule.
const EXPIRING_UNDER_MS = 5 * 60_000;

export function isExpiring(deadline: number, now: number): boolean {
  return deadline - now < EXPIRING_UNDER_MS;
}

function percentLeft(deadline: number, now: number, ttlMs: number): number {
  return ttlMs <= 0 ? 0 : Math.max(0, Math.min(100, ((deadline - now) / ttlMs) * 100));
}

// why: a local clock time, since an operator reads "granted" against their own day.
function clockTime(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export interface LeaseRowView {
  readonly key: string;
  readonly id: string;
  readonly to: string;
  readonly holder: string;
  readonly remaining: string;
  readonly expiring: boolean;
  readonly percent: number;
  readonly model: string;
  readonly worker?: string;
  readonly sub: string;
  readonly platform?: string;
}

export function leaseRows(input: {
  readonly leases: readonly LeaseRecord[];
  readonly tokens: readonly TokenRecord[];
  readonly workers: readonly WorkerView[];
  readonly now: number;
}): readonly LeaseRowView[] {
  const { leases, now, tokens, workers } = input;
  return inGrantOrder(leases).map((lease) => {
    const device = deviceOfLease(lease, workers);
    const model = device?.spec.model ?? lease.deviceId;
    const worker = workerNameOfLease(lease, workers);
    const sub = [model, worker].filter((part) => part !== undefined).join(" · ");
    return {
      expiring: isExpiring(lease.ttlDeadline, now),
      holder: holderName(lease.requesterId, tokens),
      id: lease.id,
      key: `${lease.workerId ?? ""} ${lease.id}`,
      model,
      percent: percentLeft(lease.ttlDeadline, now, lease.ttlMs),
      remaining: formatDuration(lease.ttlDeadline - now),
      sub,
      to: leasePath(lease.id),
      ...(worker === undefined ? {} : { worker }),
      ...(device === undefined ? {} : { platform: device.spec.platform }),
    };
  });
}

export function filterLeaseRows(
  rows: readonly LeaseRowView[],
  filter: LeaseFilter,
): readonly LeaseRowView[] {
  if (filter === "all") return rows;
  if (filter === "expiring") return rows.filter((row) => row.expiring);
  return rows.filter((row) => row.platform === filter);
}

export function searchLeaseRows(
  rows: readonly LeaseRowView[],
  query: string,
): readonly LeaseRowView[] {
  const wanted = query.toLowerCase();
  if (wanted === "") return rows;
  return rows.filter((row) =>
    [row.holder, row.model, row.worker, row.id].some((field) =>
      field?.toLowerCase().includes(wanted),
    ),
  );
}

export interface StreamOffer {
  readonly offered: boolean;
  readonly reason?: string;
}

// why: a worker answers a stream request with a 404 when its `stream` capability is not on, so the
// console says so before the click; a worker the console cannot see is left to the daemon's own
// answer.
export function streamOffer(worker: WorkerView | undefined): StreamOffer {
  if (worker === undefined) return { offered: true };
  const entry = worker.capabilities?.find((capability) => capability.name === "stream");
  if (entry?.state === "available") return { offered: true };
  const name = workerName(worker);
  if (entry?.state === "unavailable") {
    const reason = `Streaming is unavailable on ${name}. ${entry.reason ?? ""}`;
    return { offered: false, reason: reason.trim() };
  }
  return { offered: false, reason: `Streaming is off on ${name}.` };
}

export interface LeaseInspection {
  readonly id: string;
  readonly title: string;
  readonly expiring: boolean;
  readonly model: string;
  readonly runtime?: string;
  readonly worker?: { readonly name: string; readonly to?: string };
  readonly remaining: string;
  readonly percent?: number;
  readonly heldFor: string;
  readonly renewed: string;
  readonly granted: string;
  readonly device: {
    readonly mode?: string;
    readonly imageTag?: string;
    readonly kind?: string;
    readonly deviceId: string;
    readonly udid: string;
  };
  readonly holder?: Holder;
  readonly ownerId?: string;
  readonly requestId?: string;
  readonly stream: StreamOffer;
}

// why: `record` is the lease's entry in `GET /v1/leases`, which alone says who holds it and when it
// was renewed; without it those facts show as missing and the rest still shows.
export function leaseInspection(input: {
  readonly lease: LeaseDetails;
  readonly record: LeaseRecord | undefined;
  readonly tokens: readonly TokenRecord[];
  readonly workers: readonly WorkerView[];
  readonly now: number;
}): LeaseInspection {
  const { lease, now, record, tokens, workers } = input;
  const named = { worker: lease.worker, workerId: lease.workerId ?? record?.workerId };
  const worker = workerOfLease(named, workers);
  const device = worker?.devices?.find((candidate) => candidate.id === lease.deviceId);
  const grantedAt = Date.parse(lease.createdAt);
  const deadline = Date.parse(lease.expiresAt);
  return {
    device: leaseDevice(lease, device),
    expiring: isExpiring(deadline, now),
    granted: clockTime(grantedAt),
    heldFor: formatDuration(now - grantedAt),
    id: lease.id,
    model: lease.device,
    remaining: formatDuration(deadline - now),
    stream: streamOffer(worker),
    ...recordFacts(record, tokens, deadline, now, lease.id),
    ...defined({
      requestId: lease.requestId,
      runtime: device?.spec.osVersion,
      worker: leaseWorker(named, worker, workers),
    }),
  };
}

function leaseDevice(
  lease: LeaseDetails,
  device: WorkerDevice | undefined,
): LeaseInspection["device"] {
  return {
    deviceId: lease.deviceId,
    udid: lease.udid,
    ...defined({
      imageTag: lease.imageTag ?? device?.spec.imageTag,
      kind: device === undefined ? undefined : device.physical ? "Physical" : "Virtual",
      mode: lease.mode,
    }),
  };
}

// why: who holds a lease, when it was renewed and how much of its time is left are only in its
// entry in `GET /v1/leases`; without that entry they show as missing.
function recordFacts(
  record: LeaseRecord | undefined,
  tokens: readonly TokenRecord[],
  deadline: number,
  now: number,
  id: string,
): Pick<LeaseInspection, "renewed" | "title" | "percent" | "holder" | "ownerId"> {
  if (record === undefined) return { renewed: "—", title: id };
  const holder = holderOf(record.requesterId, tokens);
  return {
    holder,
    percent: percentLeft(deadline, now, record.ttlMs),
    renewed: `${formatDuration(now - record.lastRenewedAt)} ago`,
    title: holderTitle(holder),
    ...(record.ownerId === record.requesterId ? {} : { ownerId: record.ownerId }),
  };
}

function leaseWorker(
  named: Parameters<typeof workerNameOfLease>[0],
  worker: WorkerView | undefined,
  workers: readonly WorkerView[],
): LeaseInspection["worker"] | undefined {
  const name = workerNameOfLease(named, workers);
  if (name === undefined) return undefined;
  return worker === undefined ? { name } : { name, to: workerPath(worker.id) };
}

// why: a worker names its lease `lse_x` in its events, and a gateway lists the same lease as
// `<workerId>.lse_x`, so a relayed event matches under both spellings; the gateway's own events
// name the lease as listed.
export function eventsOfLease(
  events: readonly ConsoleEvent[],
  leaseId: string,
): readonly ConsoleEvent[] {
  return events
    .filter((event) => {
      const named = textField(event.payload, "leaseId");
      if (named === undefined) return false;
      const workerId = workerIdOf(event);
      return named === leaseId || (workerId !== undefined && `${workerId}.${named}` === leaseId);
    })
    .toSorted((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
}

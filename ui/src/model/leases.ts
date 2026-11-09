import type { z } from "zod";

import type { statusLeaseSchema, tokenRecordSchema } from "../../../src/contract/schemas";
import {
  deviceOfLease,
  holderName,
  holderOf,
  isExpiring,
  workerOfLease,
} from "../../../src/contract/inbox";
import { defined } from "./defined";
import { type ConsoleEvent, textField, workerIdOf } from "./events";
import { agentKind, shortHolder, type AgentKind } from "./holder";
import { streamOffer, streamsDevice } from "./screen";
import { formatCountdown, formatAgo, formatDuration } from "./time";
import { devicePath, streamPath } from "./paths";
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

export type LeaseFilter = "all" | "expiring" | "ios" | "android";

export const LEASE_FILTERS: readonly { readonly value: LeaseFilter; readonly label: string }[] = [
  { label: "All", value: "all" },
  { label: "Ending < 5 min", value: "expiring" },
  { label: "iOS", value: "ios" },
  { label: "Android", value: "android" },
];

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
  readonly holderTitle: string;
  readonly holderDisplay: string;
  readonly holderKind: AgentKind;
  readonly remaining: string;
  readonly expiring: boolean;
  readonly percent: number;
  readonly model: string;
  readonly worker?: string;
  readonly sub: string;
  // why: the OS the device runs, as the table's second line names it ("iOS 18.4").
  readonly runtime?: string;
  readonly platform?: string;
  readonly deviceTo?: `/${string}`;
  readonly remainingMs: number;
  readonly heldMs: number;
  readonly held: string;
  readonly renewedAgo: string;
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
    const owner = workerOfLease(lease, workers);
    const holder = holderName(lease.requesterId, tokens);
    return {
      expiring: isExpiring(lease.ttlDeadline, now),
      holder,
      holderDisplay: shortHolder(holder),
      holderKind: agentKind(lease.requesterId),
      holderTitle: lease.requesterId,
      id: lease.id,
      key: `${lease.workerId ?? ""} ${lease.id}`,
      model,
      held: formatDuration(now - lease.grantedAt),
      heldMs: Math.max(0, now - lease.grantedAt),
      percent: percentLeft(lease.ttlDeadline, now, lease.ttlMs),
      remaining: formatCountdown(lease.ttlDeadline - now),
      remainingMs: lease.ttlDeadline - now,
      renewedAgo: `${formatAgo(now - lease.lastRenewedAt)}`,
      sub,
      to: leasePath(lease.id),
      ...(worker === undefined ? {} : { worker }),
      ...(device === undefined ? {} : { platform: device.spec.platform }),
      ...runtimeOf(device),
      ...(owner === undefined ? {} : { deviceTo: devicePath(owner.id, lease.deviceId) }),
    };
  });
}

const PLATFORM_LABEL: Readonly<Record<string, string>> = { android: "Android", ios: "iOS" };

function runtimeOf(device: WorkerDevice | undefined): { readonly runtime?: string } {
  if (device === undefined) return {};
  const { osVersion, platform } = device.spec;
  const label = PLATFORM_LABEL[platform] ?? platform;
  return { runtime: osVersion === undefined ? label : `${label} ${osVersion}` };
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

export interface LeaseInspection {
  readonly id: string;
  readonly title: string;
  readonly kind: AgentKind;
  // why: the streaming page of the lease's own device, offered only where its worker streams it.
  readonly watchTo?: `/${string}`;
  // why: the TTL the countdown ring is drawn against, as the card's sentence says it ("of 15 min").
  readonly ttl?: string;
  readonly token?: string;
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
    readonly baseline?: string;
    readonly deviceId: string;
    readonly udid: string;
  };
  readonly holder?: Holder;
  readonly ownerId?: string;
  readonly requestId?: string;
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
    remaining: formatCountdown(deadline - now),
    ...recordFacts(record, tokens, deadline, now, lease.id),
    ...defined({
      requestId: lease.requestId,
      watchTo:
        worker !== undefined &&
        device !== undefined &&
        streamsDevice(device.state, streamOffer(worker))
          ? streamPath(worker.id, lease.deviceId)
          : undefined,
      runtime: runtimeOf(device).runtime,
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
      baseline:
        device?.spec.baseline === undefined
          ? undefined
          : `${device.spec.baseline.name} v${String(device.spec.baseline.version)}`,
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
): Pick<
  LeaseInspection,
  "renewed" | "title" | "kind" | "percent" | "holder" | "ownerId" | "ttl" | "token"
> {
  if (record === undefined) return { kind: "unknown", renewed: "—", title: id };
  const holder = holderOf(record.requesterId, tokens);
  return {
    holder,
    kind: agentKind(record.requesterId),
    percent: percentLeft(deadline, now, record.ttlMs),
    token: record.ownerId,
    ttl: formatDuration(record.ttlMs),
    renewed: `${formatAgo(now - record.lastRenewedAt)}`,
    title: holderName(record.requesterId, tokens),
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

export interface HolderShare {
  // why: the complete requester id: two holders whose shortened names read alike stay two.
  readonly id: string;
  readonly name: string;
  readonly display: string;
  readonly kind: AgentKind;
  readonly count: number;
  readonly percent: number;
}

export interface PlatformShare {
  readonly platform: string;
  readonly label: string;
  readonly held: number;
  readonly slots?: number;
  readonly percent: number;
}

export interface LeaseSummary {
  readonly total: number;
  readonly holders: readonly HolderShare[];
  readonly platforms: readonly PlatformShare[];
  readonly endingCount: number;
  readonly ending: readonly LeaseRowView[];
  readonly longest: readonly LeaseRowView[];
}

const SUMMARY_HOLDERS = 5;
const SUMMARY_ENDING = 5;
const SUMMARY_LONGEST = 3;

function slotsOf(workers: readonly WorkerView[], platform: string): number {
  return workers.reduce((sum, worker) => {
    const capacity = worker.capacity?.[platform === "ios" ? "ios" : "android"];
    return sum + (capacity?.limit ?? 0);
  }, 0);
}

// why: the summary counts every lease the console holds, not the page of the table the filter and the
// search leave, so it reads the same however the table is narrowed. A lease whose device is not known
// has no platform and is left out of the platform figures rather than guessed.
export function leaseSummary(
  rows: readonly LeaseRowView[],
  workers: readonly WorkerView[],
): LeaseSummary {
  const byHolder = new Map<string, { row: LeaseRowView; count: number }>();
  for (const row of rows) {
    const entry = byHolder.get(row.holderTitle);
    if (entry === undefined) byHolder.set(row.holderTitle, { count: 1, row });
    else entry.count += 1;
  }
  const holders = [...byHolder.entries()]
    .map(([id, { count, row }]) => ({
      count,
      display: row.holderDisplay,
      id,
      kind: row.holderKind,
      name: row.holder,
      percent: Math.round((count / rows.length) * 100),
    }))
    .sort((a, b) => b.count - a.count || compare(a.id, b.id))
    .slice(0, SUMMARY_HOLDERS);
  const platforms = ["ios", "android"].flatMap((platform) => {
    const held = rows.filter((row) => row.platform === platform).length;
    const slots = slotsOf(workers, platform);
    if (held === 0 && slots === 0) return [];
    return [
      {
        held,
        label: PLATFORM_LABEL[platform] ?? platform,
        percent: slots === 0 ? 100 : Math.min(100, Math.round((held / slots) * 100)),
        platform,
        ...(slots === 0 ? {} : { slots }),
      },
    ];
  });
  const expiring = rows
    .filter((row) => row.expiring)
    .toSorted((a, b) => a.remainingMs - b.remainingMs);
  return {
    ending: expiring.slice(0, SUMMARY_ENDING),
    endingCount: expiring.length,
    holders,
    longest: rows.toSorted((a, b) => b.heldMs - a.heldMs).slice(0, SUMMARY_LONGEST),
    platforms,
    total: rows.length,
  };
}

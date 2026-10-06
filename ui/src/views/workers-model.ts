/**
 * The facts the workers views show, computed from `GET /v1/workers` (ADR 0013 §1). Pure, so the
 * views stay rendering and these stay tested. The types are the contract's, imported type-only
 * (ADR 0011 §1); the values are still a claim, so every word the daemon sends is shown as it
 * came rather than looked up in a list that could be older than the daemon.
 */
import type { z } from "zod";

import type { workerViewSchema } from "../../../src/contract/schemas";
import type { Stat } from "../layout";

export type WorkerView = z.infer<typeof workerViewSchema>;
export type WorkerDevice = NonNullable<WorkerView["devices"]>[number];
export type WorkerCatalogEntry = NonNullable<WorkerView["catalog"]>[number];

export interface WorkerList {
  readonly workers: readonly WorkerView[];
}

/** A worker's name: its label, or its id when it has none. */
export function workerName(worker: WorkerView): string {
  return worker.label ?? worker.id;
}

/** The detail page of a worker. Ids are opaque, so the id is encoded. */
export function workerPath(id: string): `/${string}` {
  return `/workers/${encodeURIComponent(id)}`;
}

/** The worker id a page path names, or `undefined` for the list (`/workers`). */
export function workerIdFrom(path: string): string | undefined {
  const rest = path.replace(/^\/workers\/?/, "").replace(/\/$/, "");
  if (rest === "") return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

const PLATFORM_NAMES: Readonly<Partial<Record<string, string>>> = {
  android: "Android",
  ios: "iOS",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/** `{ running, leased }`, or `undefined` for a worker whose capacity or leases were never read, as a starting one's are not. */
export function deviceCounts(
  worker: WorkerView,
): { readonly running: number; readonly leased: number } | undefined {
  if (worker.capacity === undefined || worker.leases === undefined) return undefined;
  return { leased: worker.leases.length, running: worker.capacity.global.running };
}

/**
 * Capacity per platform, as `simlock worker list` writes it: devices running out of the limit.
 * Empty for a worker whose capacity was never read.
 */
export function capacityByPlatform(
  worker: WorkerView,
): readonly { readonly platform: string; readonly running: number; readonly limit: number }[] {
  const capacity = worker.capacity;
  if (capacity === undefined) return [];
  return [
    { limit: capacity.ios.limit, platform: "ios", running: capacity.ios.running },
    { limit: capacity.android.limit, platform: "android", running: capacity.android.running },
  ];
}

/** How many leases the workers hold between them now: where the lease chart starts from. */
export function leasesHeld(workers: readonly WorkerView[]): number {
  return workers.reduce((sum, worker) => sum + (worker.leases?.length ?? 0), 0);
}

/**
 * The Workers view's stat cards: workers connected of all, devices running of all, leases held
 * and requests waiting in the workers' own queues. A worker whose capacity was never read counts
 * no devices running, as its card says "Not reported".
 */
export function workersStats(workers: readonly WorkerView[]): readonly Stat[] {
  const connected = workers.filter((worker) => worker.connection === "connected").length;
  const devices = workers.reduce((sum, worker) => sum + (worker.devices?.length ?? 0), 0);
  const running = workers.reduce((sum, worker) => sum + (deviceCounts(worker)?.running ?? 0), 0);
  const waiting = workers.reduce((sum, worker) => sum + (worker.waiting?.length ?? 0), 0);
  return [
    { caption: `connected of ${workers.length}`, label: "Workers", value: String(connected) },
    { caption: `running of ${devices}`, label: "Devices", value: String(running) },
    { caption: "held now", label: "Leases", value: String(leasesHeld(workers)) },
    { caption: "requests in the workers' queues", label: "Waiting", value: String(waiting) },
  ];
}

/** The workers ranked by how many leases each holds now, most first; ties keep the daemon's order. */
export function busiestWorkers(workers: readonly WorkerView[]): readonly WorkerView[] {
  return [...workers].sort((a, b) => (b.leases?.length ?? 0) - (a.leases?.length ?? 0));
}

/**
 * When a device entered the state it is in, where the data says: a leased device since its
 * lease was granted, a device mid-provisioning or mid-reclaim from the age the worker reported
 * at `lastSeenAt`. That age is read only from a connected worker: a gateway moves `lastSeenAt`
 * when a worker disconnects, without reading its devices again. `undefined` for any other
 * state, which the worker view carries no time for.
 */
export function stateEnteredAt(device: WorkerDevice, worker: WorkerView): number | undefined {
  if (device.state === "leased") {
    return worker.leases?.find((lease) => lease.deviceId === device.id)?.grantedAt;
  }
  if (device.transitionAgeMs === undefined || worker.connection !== "connected") return undefined;
  return worker.lastSeenAt - device.transitionAgeMs;
}

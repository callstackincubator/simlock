import type { z } from "zod";

import type { workerViewSchema } from "../../../src/contract/schemas";

export type WorkerView = z.infer<typeof workerViewSchema>;
export type WorkerDevice = NonNullable<WorkerView["devices"]>[number];

export interface WorkerList {
  readonly workers: readonly WorkerView[];
}

export function workerName(worker: WorkerView): string {
  return worker.label ?? worker.id;
}

// why: ids are opaque, so the id is encoded.
export function workerPath(id: string): `/${string}` {
  return `/workers/${encodeURIComponent(id)}`;
}

const PLATFORM_NAMES: Readonly<Partial<Record<string, string>>> = {
  android: "Android",
  ios: "iOS",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

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

// why: a connected worker that sends no `leases` or `devices` (it is starting) has not said what it
// holds; "not known" is not "none", so a fleet that includes one has no count.
export function isUnread(worker: WorkerView): boolean {
  return (
    worker.connection === "connected" &&
    (worker.leases === undefined || worker.devices === undefined)
  );
}

export function leasesHeld(workers: readonly WorkerView[]): number | undefined {
  if (workers.some(isUnread)) return undefined;
  return workers.reduce((sum, worker) => sum + (worker.leases?.length ?? 0), 0);
}

// why: the age is read only from a connected worker: a gateway moves `lastSeenAt` when a worker
// disconnects, without reading its devices again.
export function stateEnteredAt(device: WorkerDevice, worker: WorkerView): number | undefined {
  if (device.state === "leased") {
    return worker.leases?.find((lease) => lease.deviceId === device.id)?.grantedAt;
  }
  if (device.transitionAgeMs === undefined || worker.connection !== "connected") return undefined;
  return worker.lastSeenAt - device.transitionAgeMs;
}

export type WarmTarget = NonNullable<WorkerView["warmPool"]>["targets"][number];
export type WarmPoolRow = WarmTarget & { readonly key: string };

// why: the worker sends no id, and two refused entries of one kind (or the same entry twice, with
// the pool off) look alike, so the kind alone would give them one id and the table would drop or
// repeat them on a refresh.
export function warmPoolRows(targets: readonly WarmTarget[]): WarmPoolRow[] {
  const seen = new Map<string, number>();
  return targets.map((target) => {
    const kind = `${target.platform}-${target.model}-${target.osVersion}-${target.mode}`;
    const occurrence = seen.get(kind) ?? 0;
    seen.set(kind, occurrence + 1);
    return { ...target, key: `${kind}#${occurrence}` };
  });
}

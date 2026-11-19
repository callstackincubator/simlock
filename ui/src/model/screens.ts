import { platformName } from "../../../src/contract/inbox";

import { shortHolder } from "./holder";
import { streamPath } from "./paths";
import { SCREEN_CAPTURE_LIMIT, streamOffer, streamsDevice, type StreamOffer } from "./screen";
import { formatDuration } from "./time";
import { deviceStateStatus, type Toned } from "./tones";
import { type WorkerView, workerName } from "./workers";

export interface ScreenTile {
  readonly key: string;
  readonly workerId: string;
  readonly deviceId: string;
  readonly worker: string;
  readonly label: string;
  readonly platform: string;
  readonly runtime: string;
  readonly state: Toned;
  readonly offer: StreamOffer;
  readonly to: `/${string}`;
  readonly holder?: { readonly short: string; readonly full: string };
  readonly leasedFor?: string;
}

export type ScreenFilter = "leased" | "ready" | "all";

export const SCREEN_FILTERS: readonly { readonly value: ScreenFilter; readonly label: string }[] = [
  { label: "Leased", value: "leased" },
  { label: "Ready", value: "ready" },
  { label: "All", value: "all" },
];

// why: what an operator watches is an agent's work, so leased devices come first, by holder.
export function screensOf(workers: readonly WorkerView[], now: number): ScreenTile[] {
  return workers
    .flatMap((worker) => {
      const leases = new Map((worker.leases ?? []).map((lease) => [lease.deviceId, lease]));
      return (worker.devices ?? [])
        .filter((device) => streamsDevice(device.state, { offered: true }))
        .map((device): ScreenTile => {
          const lease = device.state === "leased" ? leases.get(device.id) : undefined;
          return {
            key: JSON.stringify([worker.id, device.id]),
            workerId: worker.id,
            deviceId: device.id,
            worker: workerName(worker),
            label: device.spec.model,
            platform: platformName(device.spec.platform),
            runtime: device.spec.osVersion,
            state: deviceStateStatus(device.state),
            offer:
              worker.connection === "connected"
                ? streamOffer(worker)
                : {
                    offered: false,
                    reason: `${workerName(worker)} is ${worker.connection}.`,
                  },
            to: streamPath(worker.id, device.id),
            ...(lease === undefined
              ? {}
              : {
                  holder: { full: lease.requesterId, short: shortHolder(lease.requesterId) },
                  leasedFor: formatDuration(now - lease.grantedAt),
                }),
          };
        });
    })
    .sort(byLeaseThenHolder);
}

function byLeaseThenHolder(a: ScreenTile, b: ScreenTile): number {
  const rank = (tile: ScreenTile) => (tile.state.word === "leased" ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    compare(a.holder?.full ?? "", b.holder?.full ?? "") ||
    compare(a.key, b.key)
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function filterScreens(tiles: readonly ScreenTile[], filter: ScreenFilter): ScreenTile[] {
  return filter === "all" ? [...tiles] : tiles.filter((tile) => tile.state.word === filter);
}

// why: the watched devices live in the address, so a reload or Back from a device's page keeps
// them. A key that no longer names a running device is dropped, and never more than the budget.
const WATCH = "watch";

export function readWatch(search: string): string[] {
  return [...new Set(new URLSearchParams(search).getAll(WATCH))];
}

export function writeWatch(search: string, keys: readonly string[]): string {
  const params = new URLSearchParams(search);
  params.delete(WATCH);
  for (const key of keys.slice(0, SCREEN_CAPTURE_LIMIT)) params.append(WATCH, key);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export function watchedOf(tiles: readonly ScreenTile[], keys: readonly string[]): ScreenTile[] {
  const byKey = new Map(tiles.map((tile) => [tile.key, tile]));
  return keys.flatMap((key) => byKey.get(key) ?? []).slice(0, SCREEN_CAPTURE_LIMIT);
}

export function screenNotice(input: {
  readonly connected: boolean;
  readonly offer: StreamOffer;
  readonly active: boolean;
}): string | undefined {
  if (!input.connected) return "Disconnected from the daemon.";
  if (!input.offer.offered) return input.offer.reason ?? "Streaming is unavailable.";
  return input.active ? undefined : "Paused while this tab is hidden.";
}

export type AcquireCapture = (signal: AbortSignal) => Promise<(() => void) | undefined>;

// why: the page leaves room for data reads beside its event stream on HTTP/1. Aborting an owner
// removes its picture, but only completion of its reader's cleanup gives its place to another tile.
export function createCaptureBudget(): AcquireCapture {
  let owners = 0;
  const waiting = new Set<() => void>();
  return (signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const cancel = () => {
        waiting.delete(admit);
        signal.removeEventListener("abort", cancel);
        resolve(undefined);
      };
      const admit = () => {
        if (owners >= SCREEN_CAPTURE_LIMIT) return;
        waiting.delete(admit);
        signal.removeEventListener("abort", cancel);
        owners++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          owners--;
          for (const next of waiting) next();
        });
      };
      waiting.add(admit);
      signal.addEventListener("abort", cancel, { once: true });
      admit();
    });
}

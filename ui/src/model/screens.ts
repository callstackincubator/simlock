import { platformName } from "../../../src/contract/inbox";

import { devicePath } from "./paths";
import { SCREEN_CAPTURE_LIMIT, streamOffer, streamsDevice, type StreamOffer } from "./screen";
import { type WorkerView, workerName } from "./workers";

export interface ScreenTile {
  readonly key: string;
  readonly workerId: string;
  readonly deviceId: string;
  readonly worker: string;
  readonly label: string;
  readonly platform: string;
  readonly runtime: string;
  readonly state: string;
  readonly offer: StreamOffer;
  readonly to: `/${string}`;
}

export function screensOf(workers: readonly WorkerView[]): ScreenTile[] {
  return workers
    .flatMap((worker) =>
      (worker.devices ?? [])
        .filter((device) => streamsDevice(device.state, { offered: true }))
        .map((device) => ({
          key: JSON.stringify([worker.id, device.id]),
          workerId: worker.id,
          deviceId: device.id,
          worker: workerName(worker),
          label: device.spec.model,
          platform: platformName(device.spec.platform),
          runtime: device.spec.osVersion,
          state: device.state,
          offer:
            worker.connection === "connected"
              ? streamOffer(worker)
              : {
                  offered: false,
                  reason: `${workerName(worker)} is ${worker.connection}.`,
                },
          to: `${devicePath(worker.id, device.id)}?drawer=screen` as const,
        })),
    )
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function screenNotice(input: {
  readonly connected: boolean;
  readonly offer: StreamOffer;
  readonly active: boolean;
}): string | undefined {
  if (!input.connected) return "Disconnected from the daemon.";
  if (!input.offer.offered) return input.offer.reason ?? "Streaming is unavailable.";
  return input.active ? undefined : "Paused while out of view.";
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

import { platformName } from "../../../src/contract/inbox";

import { devicePath } from "./paths";
import { streamOffer, streamsDevice, type StreamOffer } from "./screen";
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

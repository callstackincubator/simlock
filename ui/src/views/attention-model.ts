/**
 * What needs the operator's attention, worked out from `GET /v1/workers` (ADR 0013 §1) and
 * nothing else. Pure, so the Attention view and the count in the shell read one list, and an
 * item leaves it the moment the data no longer says it.
 */
import type { Stat } from "../layout";
import type { WorkerDevice, WorkerView } from "./workers-model";

/** One thing that needs attention. `condition` is the word the console shows for it. */
export type AttentionItem =
  | {
      readonly key: string;
      readonly condition: "disconnected" | "incompatible" | "drained";
      readonly worker: WorkerView;
    }
  | {
      readonly key: string;
      readonly condition: "over RAM budget";
      readonly worker: WorkerView;
      readonly usedBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly key: string;
      readonly condition: "quarantined" | "stalled";
      readonly worker: WorkerView;
      readonly device: WorkerDevice;
    };

/**
 * Every item, worker by worker in the order the daemon lists them: the worker's own conditions
 * first, then its devices'. A worker that is both disconnected and drained is two items, since
 * each clears on its own.
 */
export function attentionItems(workers: readonly WorkerView[]): readonly AttentionItem[] {
  return workers.flatMap((worker) => [...workerItems(worker), ...deviceItems(worker)]);
}

function workerItems(worker: WorkerView): AttentionItem[] {
  const items: AttentionItem[] = [];
  const key = (condition: string) => `${worker.id}/${condition}`;
  if (worker.connection === "disconnected" || worker.connection === "incompatible") {
    items.push({ condition: worker.connection, key: key(worker.connection), worker });
  }
  if (worker.drained) items.push({ condition: "drained", key: key("drained"), worker });
  const ramBudget = worker.capacity?.ramBudget;
  if (ramBudget?.overLimit === true) {
    items.push({
      condition: "over RAM budget",
      key: key("ram"),
      limitBytes: ramBudget.limitBytes,
      usedBytes: ramBudget.usedBytes,
      worker,
    });
  }
  return items;
}

function deviceItems(worker: WorkerView): AttentionItem[] {
  return (worker.devices ?? []).flatMap((device): AttentionItem[] => {
    const key = (condition: string) => `${worker.id}/${device.id}/${condition}`;
    if (device.state === "quarantined") {
      return [{ condition: "quarantined", device, key: key("quarantined"), worker }];
    }
    if (device.stalled === true) {
      return [{ condition: "stalled", device, key: key("stalled"), worker }];
    }
    return [];
  });
}

/** The Attention view's stat cards: how many items, and how many workers and devices they name. */
export function attentionStats(items: readonly AttentionItem[]): readonly Stat[] {
  const workers = new Set(items.map((item) => item.worker.id));
  const devices = new Set(
    items.flatMap((item) => ("device" in item ? [`${item.worker.id}/${item.device.id}`] : [])),
  );
  return [
    { caption: "need attention now", label: "Items", value: String(items.length) },
    { caption: "with at least one item", label: "Workers affected", value: String(workers.size) },
    { caption: "quarantined or stalled", label: "Devices affected", value: String(devices.size) },
  ];
}

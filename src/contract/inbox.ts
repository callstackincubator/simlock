import type {
  inboxItemSchema,
  statusLeaseSchema,
  tokenRecordSchema,
  waitingRequestSchema,
  workerViewSchema,
} from "./schemas.js";
import type { z } from "zod";

export type InboxItem = z.infer<typeof inboxItemSchema>;
type WorkerView = z.infer<typeof workerViewSchema>;
type LeaseRecord = z.infer<typeof statusLeaseSchema>;
type TokenRecord = z.infer<typeof tokenRecordSchema>;
type WaitingRequest = z.infer<typeof waitingRequestSchema>;

export interface InboxContext {
  readonly now: number;
  readonly requests?: readonly WaitingRequest[] | undefined;
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly tokens?: readonly TokenRecord[] | undefined;
}

type InboxGroup = InboxItem["group"];
type WorkerItem = Extract<InboxItem, { readonly worker: unknown }>;

// why: a lost or incompatible worker is broken, which is the error tone the console shows; every
// other worker condition needs a look.
function groupOf(condition: InboxItem["condition"]): InboxGroup {
  if (condition === "ending") return "Heads-up";
  return condition === "disconnected" || condition === "incompatible" || condition === "quarantined"
    ? "Broken"
    : "Needs a look";
}

function workerSubject(worker: WorkerView): WorkerItem["worker"] {
  const { catalog: _catalog, devices, downloads: _downloads, leases, ...rest } = worker;
  return {
    ...rest,
    heldLeases: leases?.length ?? 0,
    leasedDevices: (devices ?? []).filter((device) => device.state === "leased").length,
  };
}

// why: a worker that is both disconnected and drained is two items, since each clears on its own.
export function inboxItems(
  workers: readonly WorkerView[],
  _context?: InboxContext,
): readonly InboxItem[] {
  return workers.flatMap(workerItems);
}

function workerItems(worker: WorkerView): InboxItem[] {
  const items: InboxItem[] = [];
  const subject = workerSubject(worker);
  const add = (
    condition: "disconnected" | "incompatible" | "drained" | "update failed",
    key: string,
  ) =>
    items.push({
      condition,
      group: groupOf(condition),
      key: `${worker.id}/${key}`,
      worker: subject,
    });
  if (worker.connection === "disconnected" || worker.connection === "incompatible") {
    add(worker.connection, worker.connection);
  }
  return items;
}

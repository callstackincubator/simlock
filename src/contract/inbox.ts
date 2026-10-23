// why: the one set of rules behind `inbox.get` and the helpers they call; plain functions over wire
// types with no runtime import, so the console imports this file by path (ADR 0044 §3) and reads
// what the daemon decided.
import type { z } from "zod";

import type {
  inboxItemSchema,
  statusLeaseSchema,
  tokenRecordSchema,
  waitingRequestSchema,
  workerViewSchema,
} from "./schemas.js";

type InboxItem = z.infer<typeof inboxItemSchema>;
type InboxGroup = InboxItem["group"];
type WorkerItem = Extract<InboxItem, { readonly worker: unknown }>;
type WorkerView = z.infer<typeof workerViewSchema>;
type WorkerDevice = NonNullable<WorkerView["devices"]>[number];
type LeaseRecord = z.infer<typeof statusLeaseSchema>;
type TokenRecord = z.infer<typeof tokenRecordSchema>;
type WaitingRequest = z.infer<typeof waitingRequestSchema>;

interface InboxContext {
  readonly now: number;
  readonly requests?: readonly WaitingRequest[] | undefined;
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly tokens?: readonly TokenRecord[] | undefined;
}

const WAITING_TOO_LONG_MS = 60_000;

// why: a lease with under 5 minutes left is about to end, so the list, the lease drawer, the Overview and the
// Inbox warn by the same rule.
const EXPIRING_UNDER_MS = 5 * 60_000;

export function isExpiring(deadline: number, now: number): boolean {
  return deadline - now < EXPIRING_UNDER_MS;
}

const PLATFORM_NAMES: Readonly<Partial<Record<string, string>>> = {
  android: "Android",
  ios: "iOS",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

export function describeRequestedDevice(spec: WaitingRequest["spec"]): string {
  return [
    [platformName(spec.platform), spec.model ?? spec.class]
      .filter((part) => part !== undefined)
      .join(" "),
    spec.osVersion === undefined ? undefined : `runtime ${spec.osVersion}`,
    spec.mode === undefined ? undefined : `mode ${spec.mode}`,
    spec.imageTag === undefined ? undefined : `image tag ${spec.imageTag}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

interface Holder {
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
export function holderName(requesterId: string, tokens: readonly TokenRecord[]): string {
  const holder = holderOf(requesterId, tokens);
  return holder.label ?? holder.id;
}

// why: a single host names no worker on its leases, and every lease there is on its one worker, the
// host itself.
export function workerOfLease(
  lease: { readonly workerId?: string | undefined },
  workers: readonly WorkerView[],
): WorkerView | undefined {
  if (lease.workerId === undefined) return workers.length === 1 ? workers[0] : undefined;
  return workers.find((worker) => worker.id === lease.workerId);
}

export function deviceOfLease(
  lease: LeaseRecord,
  workers: readonly WorkerView[],
): WorkerDevice | undefined {
  return workerOfLease(lease, workers)?.devices?.find((device) => device.id === lease.deviceId);
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

// why: a lost or incompatible worker and a quarantined device are broken, the error tone the console
// shows; a lease about to end is only a heads-up; everything else needs a look.
function groupOf(condition: InboxItem["condition"]): InboxGroup {
  if (condition === "ending") return "Heads-up";
  return condition === "disconnected" || condition === "incompatible" || condition === "quarantined"
    ? "Broken"
    : "Needs a look";
}

// why: the sidebar and Overview count what is a problem now, so a heads-up is left out.
export function problemCount(items: readonly { readonly group: InboxGroup }[]): number {
  return items.filter((item) => item.group !== "Heads-up").length;
}

// why: a worker that is both disconnected and drained is two items, since each clears on its own.
export function inboxItems(
  workers: readonly WorkerView[],
  context?: InboxContext,
): readonly InboxItem[] {
  return [
    ...workers.flatMap((worker) => [...workerItems(worker), ...deviceItems(worker)]),
    ...(context === undefined ? [] : waitingItems(context)),
    ...(context === undefined ? [] : endingItems(workers, context)),
  ];
}

// why: a request waits on the daemon's clock, so the wait is counted from the daemon's now; the
// longest wait comes first.
function waitingItems(context: InboxContext): InboxItem[] {
  return [...(context.requests ?? [])]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .filter((request) => context.now - request.createdAt > WAITING_TOO_LONG_MS)
    .map((request) => ({
      condition: "waiting",
      group: groupOf("waiting"),
      key: `request/${request.id}/waiting`,
      request,
    }));
}

// why: a lease's time left counts against the daemon's clock, and the least time left comes first.
function endingItems(workers: readonly WorkerView[], context: InboxContext): InboxItem[] {
  const { now, tokens = [] } = context;
  return [...(context.leases ?? [])]
    .sort((a, b) => a.ttlDeadline - b.ttlDeadline || (a.id < b.id ? -1 : 1))
    .filter((lease) => isExpiring(lease.ttlDeadline, now))
    .map((lease) => ({
      condition: "ending",
      group: groupOf("ending"),
      key: `lease/${lease.id}/ending`,
      lease: {
        ...lease,
        holder: holderName(lease.requesterId, tokens),
        model: deviceOfLease(lease, workers)?.spec.model ?? lease.deviceId,
      },
    }));
}

function workerSubject(worker: WorkerView): WorkerItem["worker"] {
  const { catalog: _catalog, devices, downloads: _downloads, leases, ...rest } = worker;
  return {
    ...rest,
    heldLeases: leases?.length ?? 0,
    leasedDevices: (devices ?? []).filter((device) => device.state === "leased").length,
  };
}

function workerItems(worker: WorkerView): InboxItem[] {
  const items: InboxItem[] = [];
  const subject = workerSubject(worker);
  const key = (condition: string) => `${worker.id}/${condition}`;
  const add = (
    condition: "disconnected" | "incompatible" | "drained" | "update failed",
    keyed: string,
  ) => items.push({ condition, group: groupOf(condition), key: key(keyed), worker: subject });
  if (worker.connection === "disconnected" || worker.connection === "incompatible") {
    add(worker.connection, worker.connection);
  }
  if (worker.drained) add("drained", "drained");
  if (worker.lastUpdateFailure !== undefined && worker.lastUpdateFailure !== null) {
    add("update failed", "update-failed");
  }
  const ramBudget = worker.capacity?.ramBudget;
  if (ramBudget?.overLimit === true) {
    items.push({
      condition: "over RAM budget",
      group: groupOf("over RAM budget"),
      key: key("ram"),
      limitBytes: ramBudget.limitBytes,
      usedBytes: ramBudget.usedBytes,
      worker: subject,
    });
  }
  return items;
}

function deviceItems(worker: WorkerView): InboxItem[] {
  return (worker.devices ?? []).flatMap((device): InboxItem[] => {
    const condition = deviceCondition(device);
    if (condition === undefined) return [];
    const since = stateEnteredAt(device, worker);
    return [
      {
        condition,
        device: {
          ...device,
          workerId: worker.id,
          ...(worker.label === undefined ? {} : { workerLabel: worker.label }),
          ...(since === undefined ? {} : { stateEnteredAt: since }),
        },
        group: groupOf(condition),
        key: `${worker.id}/${device.id}/${condition}`,
      },
    ];
  });
}

function deviceCondition(device: WorkerDevice): "quarantined" | "stalled" | "absent" | undefined {
  if (device.state === "quarantined") return "quarantined";
  if (device.stalled === true) return "stalled";
  return device.state === "absent" ? "absent" : undefined;
}

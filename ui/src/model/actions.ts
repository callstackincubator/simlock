// why: ADR 0037 §3. One action list per kind of item, read by every surface that offers it; the
// wording of each dialog and toast is fixed here, so no surface words it differently.
import type { InboxItem } from "./inbox";
import { type TokenRecord, leaseRows } from "./leases";
import { requestedDevice } from "./waiting";
import { type WorkerView, workerName } from "./workers";

export type DaemonModeName = "gateway" | "worker";

export interface ActionConfirm {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  readonly busy: string;
  readonly typeToConfirm?: string;
}

export interface ActionToast {
  readonly title: string;
  readonly description?: string;
  readonly view?: { readonly label: string; readonly to: `/${string}` };
}

export interface ItemAction {
  readonly id: "release-lease" | "cancel-request" | "drain" | "undrain" | "remove-worker";
  readonly itemKey: string;
  readonly label: string;
  readonly danger: boolean;
  readonly method: "DELETE" | "POST";
  readonly path: `/v1/${string}`;
  readonly confirm?: ActionConfirm;
  readonly success: ActionToast;
  // why: the title of the error toast when the daemon refuses, word for word from the spec.
  readonly failure: string;
  // why: an action that asks nothing can be undone from its toast, by running this one.
  readonly undo?: ItemAction;
}

export interface LeaseActionInput {
  readonly key: string;
  readonly id: string;
  readonly holder: string;
  readonly model: string;
  readonly worker?: string;
  readonly deviceTo?: `/${string}`;
}

export function leaseActions(lease: LeaseActionInput): readonly ItemAction[] {
  const device = lease.worker === undefined ? lease.model : `${lease.model} on ${lease.worker}`;
  return [
    {
      confirm: {
        body: `${device} goes back to the pool now, and ${lease.holder}'s next command on it fails.`,
        busy: "Releasing…",
        confirm: "Release lease",
        title: `Release ${lease.holder}'s lease?`,
      },
      danger: true,
      id: "release-lease",
      itemKey: lease.key,
      label: "Release lease",
      method: "DELETE",
      path: `/v1/leases/${encodeURIComponent(lease.id)}`,
      failure: `Couldn't release ${lease.holder}'s lease`,
      success: {
        description: `${device} goes back to the pool.`,
        title: `Released ${lease.holder}'s lease`,
        ...(lease.deviceTo === undefined
          ? {}
          : { view: { label: "View device", to: lease.deviceTo } }),
      },
    },
  ];
}

export interface RequestActionInput {
  readonly key: string;
  readonly id: string;
  readonly requester: string;
  readonly device: string;
}

export function requestActions(request: RequestActionInput): readonly ItemAction[] {
  return [
    {
      confirm: {
        body: `${request.requester} stops waiting for ${request.device} and gets an error.`,
        busy: "Cancelling…",
        confirm: "Cancel request",
        title: `Cancel ${request.requester}'s request?`,
      },
      danger: true,
      id: "cancel-request",
      itemKey: request.key,
      label: "Cancel request",
      method: "DELETE",
      path: `/v1/lease-requests/${encodeURIComponent(request.id)}`,
      failure: `Couldn't cancel ${request.requester}'s request`,
      success: { title: `Cancelled ${request.requester}'s request` },
    },
  ];
}

export interface WorkerActionInput {
  readonly id: string;
  readonly name: string;
  readonly connection: WorkerView["connection"];
  readonly drained: boolean;
}

// why: ADR 0037 §4. On a single host the three worker routes answer 501, and when the mode is not
// known the console never guesses `gateway`, so neither offers a worker action.
export function workerActions(
  worker: WorkerActionInput,
  mode: DaemonModeName | undefined,
): readonly ItemAction[] {
  if (mode !== "gateway") return [];
  const itemKey = `worker/${worker.id}`;
  const path = `/v1/workers/${encodeURIComponent(worker.id)}` as const;
  const undrain: ItemAction = {
    danger: false,
    id: "undrain",
    itemKey,
    label: "Undrain",
    method: "DELETE",
    path: `${path}/drain`,
    failure: `Couldn't undrain ${worker.name}`,
    success: { title: `${worker.name} takes leases again` },
  };
  const drain: ItemAction = {
    danger: false,
    id: "drain",
    itemKey,
    label: "Drain",
    method: "POST",
    path: `${path}/drain`,
    failure: `Couldn't drain ${worker.name}`,
    success: {
      description: "Its leases keep running. New leases go to other workers.",
      title: `${worker.name} drained`,
    },
    undo: undrain,
  };
  const actions: ItemAction[] = [worker.drained ? undrain : drain];
  if (worker.connection === "disconnected") {
    actions.push({
      confirm: {
        body: "It leaves the fleet and its devices are forgotten. It can join again with a worker token.",
        busy: "Removing…",
        confirm: "Remove worker",
        title: `Remove ${worker.name}?`,
        typeToConfirm: worker.name,
      },
      danger: true,
      id: "remove-worker",
      itemKey,
      label: "Remove worker",
      method: "DELETE",
      path,
      failure: `Couldn't remove ${worker.name}`,
      success: { title: `${worker.name} removed` },
    });
  }
  return actions;
}

export interface InboxActionContext {
  readonly mode: DaemonModeName | undefined;
  readonly now: number;
  readonly tokens: readonly TokenRecord[];
  readonly workers: readonly WorkerView[];
}

// why: only a drained worker's item has a fix button, and its fix is Undrain; every other action of
// an item is in its menu. Device conditions (a quarantined or stalled device) are about a device, so
// they offer no worker action.
export function inboxActions(
  item: InboxItem,
  context: InboxActionContext,
): { readonly fix?: ItemAction; readonly menu: readonly ItemAction[] } {
  switch (item.condition) {
    case "waiting":
      return {
        menu: requestActions({
          device: requestedDevice(item.request.spec),
          id: item.request.id,
          key: `${item.request.workerId ?? ""}/${item.request.id}`,
          requester: item.request.requesterId,
        }),
      };
    case "ending": {
      const [row] = leaseRows({
        leases: [item.lease],
        now: context.now,
        tokens: context.tokens,
        workers: context.workers,
      });
      return { menu: row === undefined ? [] : leaseActions(row) };
    }
    case "quarantined":
    case "stalled":
    case "absent":
      return { menu: [] };
    case "disconnected":
    case "incompatible":
    case "drained":
    case "over RAM budget": {
      const menu = workerActions(
        {
          connection: item.worker.connection,
          drained: item.worker.drained,
          id: item.worker.id,
          name: workerName(item.worker),
        },
        context.mode,
      );
      const fix = item.condition === "drained" ? menu.find((a) => a.id === "undrain") : undefined;
      return fix === undefined ? { menu } : { fix, menu };
    }
  }
}

// why: ADR 0037 §3. One action list per kind of item, read by every surface that offers it; the
// wording of each dialog and toast is fixed here, so no surface words it differently.
export interface ActionConfirm {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  readonly busy: string;
}

export interface ActionToast {
  readonly title: string;
  readonly description?: string;
  readonly view?: { readonly label: string; readonly to: `/${string}` };
}

export interface ItemAction {
  readonly id: "release-lease";
  readonly itemKey: string;
  readonly label: string;
  readonly danger: boolean;
  readonly method: "DELETE" | "POST";
  readonly path: `/v1/${string}`;
  readonly confirm?: ActionConfirm;
  readonly success: ActionToast;
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

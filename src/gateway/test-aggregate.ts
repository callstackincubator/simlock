import type { WorkerView } from "./worker-registry.js";

export function view(overrides: Partial<WorkerView> & { readonly id: string }): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    lastSeenAt: 1_000,
    leases: [],
    ...overrides,
  };
}

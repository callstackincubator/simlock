/**
 * The one place a worker's own reads become the fields of its worker view (ADR 0012 §1).
 *
 * A gateway reads `status.get`, `list.get` for devices, `catalog.get` and `config.get` over a
 * worker's uplink; a worker answering `worker.list` about itself reads the same four from its
 * own dispatcher. Both call this function, so the two views cannot disagree about a field. Each
 * caller adds what only it knows: `id`, `label`, `connection`, `drained`, `lastSeenAt` and
 * `version`.
 *
 * Pure: no I/O, no clock, nothing outside the contract module.
 */
import { z } from "zod";

import type { OPERATIONS } from "./operations.js";
import { statusDeviceSchema, type workerViewSchema } from "./schemas.js";

/**
 * How often a worker view is re-read in full, catalog and config included, when no event asks
 * for it sooner. A gateway refreshes every view on this tick (ADR 0005 §7's backstop), and a
 * worker answering `worker.list` about itself re-reads its catalog no more often, so an open
 * console polling `GET /v1/workers` does not run a driver's catalog read on every poll. Both
 * re-read the catalog at once after a component install.
 */
export const WORKER_VIEW_REFRESH_INTERVAL_MS = 30_000;

/**
 * The events after which a worker view's catalog is read again at once, rather than on the
 * interval above. One list, read by a gateway's `WorkerLink` and by a worker answering
 * `worker.list`, so both re-read on the same events (architecture rule 10). An installed
 * component is a new catalog entry (ADR 0010 §7); a removal shows on the next interval.
 */
export const WORKER_VIEW_CATALOG_EVENTS = ["component.installed"] as const;

type Output<Name extends keyof typeof OPERATIONS> = z.infer<(typeof OPERATIONS)[Name]["output"]>;
type WorkerView = z.infer<typeof workerViewSchema>;

/** The answers a view is built from. `catalog` and `config` are optional because a gateway's
 * per-event refresh re-reads only status and devices; a field left out stays as it was.
 * `devices` is optional because a starting worker is not asked for them. */
export interface WorkerReads {
  readonly status: Output<"status.get">;
  readonly devices?: Output<"list.get">;
  readonly catalog?: Output<"catalog.get">;
  readonly config?: Output<"config.get">;
}

export type WorkerViewReport = Pick<WorkerView, "health" | "host"> &
  Partial<
    Pick<
      WorkerView,
      | "capabilities"
      | "capacity"
      | "catalog"
      | "devices"
      | "downloads"
      | "installs"
      | "lease"
      | "leases"
      | "physicalQueueDepth"
      | "queueDepth"
      | "waiting"
      | "warmPool"
    >
  >;

/** Narrowed so `driverData` -- an opaque, driver-defined blob -- stays out of every view. */
const viewDevicesSchema = z.array(statusDeviceSchema);

export function workerViewFields(reads: WorkerReads): WorkerViewReport {
  const { catalog, config, devices, status } = reads;
  // A starting worker has checked nothing: its view is its health and its host, and every other
  // field is absent -- never empty, which would read as "nothing is leased".
  if (status.daemon.health === "starting") return { health: "starting", host: status.host };
  return {
    health: status.daemon.health,
    host: status.host,
    installs: status.installs ?? [],
    waiting: status.waiting ?? [],
    ...(status.capabilities === undefined ? {} : { capabilities: status.capabilities }),
    ...(status.capacity === undefined ? {} : { capacity: status.capacity }),
    ...(status.warmPool === undefined ? {} : { warmPool: status.warmPool }),
    ...(status.leases === undefined ? {} : { leases: status.leases }),
    ...(status.queueDepth === undefined ? {} : { queueDepth: status.queueDepth }),
    ...(status.physicalQueueDepth === undefined
      ? {}
      : { physicalQueueDepth: status.physicalQueueDepth }),
    ...(devices === undefined ? {} : { devices: viewDevicesSchema.parse(devices) }),
    ...(catalog === undefined ? {} : { catalog: catalog.platforms }),
    ...(config === undefined
      ? {}
      : {
          downloads: { policy: config.downloads.policy, timeoutMs: config.downloads.timeoutMs },
          lease: { maxTtlMs: config.lease.maxTtlMs },
        }),
  };
}

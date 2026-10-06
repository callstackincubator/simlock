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

/** The view fields the reads fill. `catalog`, `downloads` and `lease` are present only when the
 * reads that carry them were made, and every field a running worker's reads fill is absent for
 * a worker that is starting. */
export type WorkerViewReport = Pick<WorkerView, "health" | "host"> &
  Partial<
    Pick<
      WorkerView,
      | "capacity"
      | "catalog"
      | "devices"
      | "downloads"
      | "installs"
      | "lease"
      | "leases"
      | "queueDepth"
      | "waiting"
      | "warmPool"
    >
  >;

/** The device shape a view carries. `list.get` answers an admin with full `DeviceRecord`s;
 * narrowing them here keeps `driverData` -- an opaque, driver-defined blob -- out of every
 * view, on a gateway and on a worker alike. */
const viewDevicesSchema = z.array(statusDeviceSchema);

export function workerViewFields(reads: WorkerReads): WorkerViewReport {
  const { catalog, config, devices, status } = reads;
  // A starting worker has checked nothing: its view is its health and its host, and every other
  // field is absent -- never empty, which would read as "nothing is leased".
  if (status.daemon.health === "starting") return { health: "starting", host: status.host };
  return {
    health: status.daemon.health,
    host: status.host,
    // ADR 0010 §7: copied as the worker lists them, already bounded by the contract's parse
    // (safety rule 10). A worker too old to list installs reports none.
    installs: status.installs ?? [],
    // Copied as `installs` is: the requests waiting in the worker's own queue. A worker too old
    // to list them reports none.
    waiting: status.waiting ?? [],
    ...(status.capacity === undefined ? {} : { capacity: status.capacity }),
    ...(status.leases === undefined ? {} : { leases: status.leases }),
    ...(status.queueDepth === undefined ? {} : { queueDepth: status.queueDepth }),
    ...(devices === undefined ? {} : { devices: viewDevicesSchema.parse(devices) }),
    ...(catalog === undefined ? {} : { catalog: catalog.platforms }),
    ...(config === undefined
      ? {}
      : {
          // ADR 0010 §7: the worker's own install budget, read with its policy.
          downloads: { policy: config.downloads.policy, timeoutMs: config.downloads.timeoutMs },
          // ADR 0005 §15: a gateway compares this against its own `lease.maxTtlMs`.
          lease: { maxTtlMs: config.lease.maxTtlMs },
        }),
  };
}

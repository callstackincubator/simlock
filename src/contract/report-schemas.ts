import { z } from "zod";

import {
  baselineNameSchema,
  DRIVER_DETAIL_MAX,
  platformSchema,
  statusDeviceSchema,
} from "./device-schemas.js";
import { waitingRequestSchema } from "./lease-schemas.js";
import { deviceModeSchema } from "./schema-parts.js";
import { capabilityNameSchema, statusLeaseSchema, workerViewSchema } from "./status-schemas.js";

export const proposalSchema = z.object({
  action: z.enum(["shutdown", "destroy"]),
  reason: z.string(),
  rule: z.string(),
  target: z.string(),
});

export const cleanupRuleSummarySchema = z.object({ name: z.string() });

/** why: Mirrors `DriverDevice` (src/core/driver.ts) -- `driverData` stays opaque `unknown` on
 * purpose, exactly as the core treats it. */
const driverDeviceSchema = z.object({
  deviceId: z.string(),
  driverData: z.unknown().optional(),
  address: z.string(),
  mode: deviceModeSchema.optional(),
});

// why: mirrors the `DoctorFinding` union (src/core/doctor.ts) field for field, so a new member lands in both.
const doctorFindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("registry-device-missing"),
    deviceId: z.string(),
    platform: platformSchema,
  }),
  z.object({
    kind: z.literal("orphan-device"),
    device: driverDeviceSchema,
    platform: platformSchema,
  }),
  z.object({
    kind: z.literal("orphan-process"),
    device: driverDeviceSchema,
    platform: platformSchema,
  }),
  z.object({ kind: z.literal("expired-live-lease"), leaseId: z.string(), deviceId: z.string() }),
  z.object({
    kind: z.literal("foreign-state-change"),
    deviceId: z.string(),
    platform: platformSchema,
    expected: z.enum(["running", "stopped"]),
    observed: z.enum(["running", "stopped"]),
  }),
  z.object({
    kind: z.literal("foreign-provenance-change"),
    deviceId: z.string(),
    platform: platformSchema,
    detail: z.enum(["erased", "mark-mismatch", "durable-mark-missing"]),
  }),
  z.object({
    kind: z.literal("stalled-transition"),
    deviceId: z.string(),
    platform: platformSchema,
    state: z.enum(["provisioning", "reclaiming"]),
    enteredAt: z.number(),
    ageMs: z.number(),
    thresholdMs: z.number(),
  }),
  z.object({
    kind: z.literal("driver-advisory"),
    platform: platformSchema,
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("driver-unavailable"),
    platform: platformSchema,
    reason: z.string().max(64),
    detail: z.string().max(DRIVER_DETAIL_MAX),
  }),
  z.object({
    kind: z.literal("service-broken"),
    manager: z.enum(["launchd", "systemd"]),
    name: z.string(),
    missing: z.array(z.string()).min(1),
    remedy: z.string(),
  }),
  z.object({
    kind: z.literal("prerequisite-missing"),
    platform: platformSchema,
    prerequisite: z.string(),
    message: z.string(),
    remedy: z.string(),
  }),
  z.object({
    kind: z.literal("warm-pool-target-unreachable"),
    platform: platformSchema.optional(),
    target: z.string(),
    reason: z.enum(["runtime-missing", "unknown-model", "over-limit"]),
    message: z.string(),
    remedy: z.string(),
  }),
  z.object({
    kind: z.literal("module-unavailable"),
    module: capabilityNameSchema,
    message: z.string(),
    remedy: z.string(),
  }),
]);

const doctorSourceSchema = z.object({
  platform: platformSchema,
  kind: z.enum(["seed", "baseline"]),
  model: z.string().max(200),
  osVersion: z.string().max(200),
  imageTag: z.string().max(200).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  staleReason: z.string().max(300).optional(),
  orphan: z.literal(true).optional(),
  baselineName: baselineNameSchema.optional(),
  baselineVersion: z.number().int().min(1).optional(),
});

export const doctorReportSchema = z.object({
  findings: z.array(doctorFindingSchema).max(100_000),
  sources: z.array(doctorSourceSchema).max(100_000),
});

export const nukeReportSchema = z.object({
  deletedDevices: z.array(z.string()),
  releasedLeaseIds: z.array(z.string()),
  removedBaselines: z.array(baselineNameSchema).max(1000),
});

const MAX_DATE_MS = 8.64e15;

export const historyStatusSchema = z.object({
  opened: z.boolean(),
  writing: z.boolean(),
  setAsideAt: z.number().min(-MAX_DATE_MS).max(MAX_DATE_MS).optional(),
  rebuiltAt: z.number().min(-MAX_DATE_MS).max(MAX_DATE_MS).optional(),
  rebuildFailed: z.literal(true).optional(),
});

export const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_-]{1,64}$/;

export const eventEnvelopeSchema = z.object({
  id: z.string().regex(EVENT_ID_PATTERN),
  seq: z.number(),
  timestamp: z.number().min(-MAX_DATE_MS).max(MAX_DATE_MS),
  event: z.string(),
  payload: z.unknown().optional(),
  module: z.string(),
});
const inboxGroupSchema = z.enum(["Broken", "Needs a look", "Heads-up"]);

// why: an Inbox item names the worker it is about by the view's fields that the page does not read from the worker list, plus two counts the view's lists would otherwise have to be sent for.
const inboxWorkerSchema = workerViewSchema
  .omit({ baselines: true, catalog: true, devices: true, downloads: true, leases: true })
  .extend({
    heldLeases: z.number().int().nonnegative(),
    leasedDevices: z.number().int().nonnegative(),
  });

const inboxDeviceSchema = statusDeviceSchema.and(
  z.object({
    stateEnteredAt: z.number().optional(),
    workerId: z.string(),
    workerLabel: z.string().optional(),
  }),
);

const inboxLeaseSchema = statusLeaseSchema.extend({
  holder: z.string(),
  model: z.string(),
});

const inboxItemBase = { group: inboxGroupSchema, key: z.string() };

export const inboxItemSchema = z.union([
  z.object({
    ...inboxItemBase,
    condition: z.enum(["disconnected", "incompatible", "drained", "update failed"]),
    worker: inboxWorkerSchema,
  }),
  z.object({
    ...inboxItemBase,
    condition: z.literal("over RAM budget"),
    limitBytes: z.number(),
    usedBytes: z.number(),
    worker: inboxWorkerSchema,
  }),
  z.object({
    ...inboxItemBase,
    condition: z.enum(["quarantined", "stalled", "absent"]),
    device: inboxDeviceSchema,
  }),
  z.object({
    ...inboxItemBase,
    condition: z.literal("waiting"),
    request: waitingRequestSchema,
  }),
  z.object({
    ...inboxItemBase,
    condition: z.literal("ending"),
    lease: inboxLeaseSchema,
  }),
]);

const USAGE_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const usageWindowSchema = z
  .object({
    from: z.number().int().min(0).max(MAX_DATE_MS),
    includeLedger: z.boolean().optional(),
    to: z.number().int().min(0).max(MAX_DATE_MS),
  })
  .refine((window) => window.from < window.to, { message: "from must be before to" })
  .refine((window) => window.to - window.from <= USAGE_MAX_WINDOW_MS, {
    message: "the window must not be longer than 90 days",
  });

const usageSamplesSchema = z.object({
  count: z.number().int().nonnegative(),
  max: z.number().nullable(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
});

const usageCountsSchema = z.record(z.string(), z.number().int().nonnegative());

const usageFiguresSchema = z.object({
  bySource: z.object({
    booted: z.number().int().nonnegative(),
    provisioned: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative().optional(),
    warm: z.number().int().nonnegative(),
  }),
  boot: usageSamplesSchema,
  declined: z.number().int().nonnegative(),
  failures: z.object({ byEvent: usageCountsSchema }),
  granted: z.number().int().nonnegative(),
  held: usageSamplesSchema,
  incidents: z.object({
    crashRecovered: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    quarantineRecovered: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
  }),
  probes: z.number().int().nonnegative().optional(),
  provisioning: usageSamplesSchema,
  queue: z.object({ meanDepth: z.number().nullable(), peakDepth: z.number().nullable() }),
  rejected: z.object({
    byReason: usageCountsSchema,
    total: z.number().int().nonnegative(),
  }),
  requests: z.number().int().nonnegative(),
  turnaround: usageSamplesSchema,
  utilisation: z.object({
    ram: z
      .object({
        limitBytes: z.number(),
        meanBytes: z.number(),
        peakBytes: z.number(),
      })
      .optional(),
    slots: z.object({
      max: z.number().nullable(),
      mean: z.number().nullable(),
      peak: z.number().nullable(),
    }),
  }),
  wait: usageSamplesSchema,
});

export const USAGE_LEDGER_MAX_ENTRIES = 100_000;

const usageLedgerEntrySchema = z.object({
  endReason: z.string().optional(),
  endedAt: z.number().optional(),
  grantedAt: z.number().optional(),
  heldMs: z.number().optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  outcome: z.enum(["granted", "rejected", "declined", "open"]),
  platform: z.string(),
  probe: z.boolean(),
  reason: z.string().optional(),
  rejectedAt: z.number().optional(),
  requestId: z.string(),
  requestedAt: z.number(),
  requester: z.string(),
  source: z.string().optional(),
  turnaroundMs: z.number().optional(),
  waitMs: z.number().optional(),
  workerId: z.string().optional(),
});

export type UsageLedgerEntry = z.infer<typeof usageLedgerEntrySchema>;

export const usageOutputSchema = z.object({
  bucketMs: z.number().int().positive(),
  coversFrom: z.number(),
  ledgerTruncated: z.literal(true).optional(),
  requests: z.array(usageLedgerEntrySchema).optional(),
  partial: z.boolean(),
  platforms: z.object({ android: usageFiguresSchema, ios: usageFiguresSchema }),
  requesters: z.array(
    z.object({
      granted: z.number().int().nonnegative(),
      heldTotalMs: z.number().nonnegative(),
      id: z.string(),
      label: z.string().optional(),
      rejected: z.number().int().nonnegative(),
      requests: z.number().int().nonnegative(),
    }),
  ),
  series: z.array(
    z.object({
      at: z.number(),
      leasesHeld: z.number().nullable(),
      queueDepth: z.number().nullable(),
      ramUsedBytes: z.number().optional(),
      slotsMax: z.number().nullable(),
      slotsUsed: z.number().nullable(),
      waiting: z.number().nullable(),
    }),
  ),
  totals: usageFiguresSchema,
  window: z.object({ from: z.number(), to: z.number() }),
  workers: z.array(usageFiguresSchema.extend({ id: z.string(), label: z.string().optional() })),
});

export type UsageFigures = z.infer<typeof usageFiguresSchema>;
export type UsageOutput = z.infer<typeof usageOutputSchema>;

/**
 * Zod schemas re-declaring today's wire shapes for the contract module (ADR 0003 §1).
 *
 * These schemas deliberately do NOT import their "real" counterparts from `src/core` --
 * `DeviceRecord`, `LeaseRecord`, `Config`, `DoctorFinding`, `Proposal`, `EventEnvelope`, and so
 * on are core-private types. Re-declaring their fields here, by hand, is exactly what keeps
 * private domain records off the public package surface (the daemon maps its own records onto
 * these shapes in exactly one place -- `DaemonDispatcher#dispatch`'s `#parseOutput` call in
 * `src/daemon/dispatcher.ts`, which parses every handler's result through the operation's
 * output schema before it reaches a transport, stripping any field (such as `DeviceRecord`'s
 * quarantine/foreign/recovery bookkeeping) that a narrower output schema like
 * `grantedDeviceSchema` does not declare). If a core type's shape changes
 * without a matching edit here, that is a compile-time or (for shapes structurally compatible
 * but semantically different) a runtime output-validation failure at the daemon boundary --
 * see `DaemonServer`'s output parsing -- not a silent drift.
 *
 * This module must never import from src/core, src/daemon, src/drivers, src/http, src/cli,
 * src/mcp, or src/ports -- enforced by a test, see `boundary.test.ts`.
 */
import { z } from "zod";

export const platformSchema = z.enum(["ios", "android"]);
export type Platform = z.infer<typeof platformSchema>;

const deviceStateSchema = z.enum([
  "provisioning",
  "ready",
  "leased",
  "reclaiming",
  "quarantined",
  "shutdown",
  "deleted",
]);

const featureProfileSchema = z.enum(["full", "reduced"]);

const deviceSpecSchema = z.object({
  platform: platformSchema,
  model: z.string(),
  osVersion: z.string(),
  full: z.boolean().optional(),
});

/** Mirrors `DeviceRecord` (src/core/domain.ts) field for field, plus the `status`/`list`
 * decoration's derived `transitionAgeMs` (see `DaemonServer#decorateDevice`). */
export const deviceRecordSchema = z.object({
  id: z.string(),
  driverDeviceId: z.string(),
  spec: deviceSpecSchema,
  state: deviceStateSchema,
  driverData: z.unknown(),
  createdAt: z.number(),
  lastLeaseEndedAt: z.number().optional(),
  foreignStateDetectedAt: z.number().optional(),
  foreignProvenanceDetectedAt: z.number().optional(),
  recoveringSince: z.number().optional(),
  recoveryAttempts: z.number().optional(),
  quarantinedAt: z.number().optional(),
  quarantineAttempts: z.number().optional(),
  quarantineNextRetryAt: z.number().optional(),
  address: z.string().optional(),
  featureProfile: featureProfileSchema.optional(),
  /** Decoration added by `status.get`/`list.get`; absent for a device not mid-transition. */
  transitionAgeMs: z.number().optional(),
});

/**
 * The device shape `status.get` returns (ADR §3: `status.get` is `role: "agent"`, with no
 * ownership check -- it reports on every device in the registry, not just ones the caller
 * leases). Deliberately narrower than `deviceRecordSchema`, for the same reason
 * `grantedDeviceSchema` is narrower than it: an agent is not an operator inspecting the
 * registry, and `deviceRecordSchema`'s `driverData` is an opaque, driver-defined blob whose
 * contents this contract cannot bound -- handing it to every agent for every device
 * (including devices other principals hold) is exactly the leak this schema exists to close.
 *
 * What stays, and why: `status.get` is what `simlock status` renders for a human (ADR §11,
 * "Human-readable status ... formatting stays"), and that rendering legitimately surfaces
 * device health, not just identity --
 *
 * - `id`, `spec`: which device this is.
 * - `state`: the human-status line's primary content (`Device <id>: <state>`).
 * - `foreignStateDetectedAt`, `foreignProvenanceDetectedAt`: surfaced as "foreign state/
 *   provenance change" markers -- an agent legitimately wants to know a device it might be
 *   about to request was tampered with outside simlock.
 * - `quarantineAttempts`, `quarantineNextRetryAt`: surfaced as purge-retry progress for a
 *   quarantined device, so a caller waiting on capacity can see why a slot isn't freeing up.
 * - `transitionAgeMs`: the mid-transition decoration, surfaced as "mid-transition <ms>".
 *
 * What stays off, and why: `driverDeviceId` (the driver address of a device the caller does
 * not hold is not actionable -- a non-owning agent cannot drive it, and a holder already gets
 * it on their grant), `driverData` (opaque driver-private blob, unbounded contents),
 * `createdAt`/`lastLeaseEndedAt` (internal bookkeeping timestamps the human formatter never
 * reads), `recoveringSince`/`recoveryAttempts` (crash-recovery bookkeeping -- `safety.md` rule
 * 2 scopes that privilege narrowly, and broadcasting its progress to every agent is not part of
 * that scope), `quarantinedAt` (superseded by `quarantineAttempts`/`quarantineNextRetryAt` for
 * what a caller needs), and `address`/`featureProfile` (only meaningful to whoever is driving
 * the device, i.e. the lease holder, who gets them on the grant).
 */
export const statusDeviceSchema = z.object({
  id: z.string(),
  spec: deviceSpecSchema,
  state: deviceStateSchema,
  foreignStateDetectedAt: z.number().optional(),
  foreignProvenanceDetectedAt: z.number().optional(),
  quarantineAttempts: z.number().optional(),
  quarantineNextRetryAt: z.number().optional(),
  /** Decoration added by `status.get`; absent for a device not mid-transition. */
  transitionAgeMs: z.number().optional(),
});

/**
 * The device a `lease.request`/`lease.renew` grant carries -- deliberately narrower than
 * `deviceRecordSchema` (ADR 0003 §1: "the daemon maps [core records] onto contract types in
 * exactly one place"). A grant is agent-facing, not an admin inspection of the registry, so it
 * carries only what a caller needs to drive the device it was just handed:
 *
 * - `id`: the lease-facing device identity (what `lease.list`/`lease.renew` correlate against).
 * - `driverDeviceId`: the driver address a caller actually drives (simctl UDID / adb serial).
 * - `spec`, `address`, `featureProfile`: same meanings as on `DeviceRecord` (src/core/domain.ts).
 *
 * Everything else on `DeviceRecord` -- `driverData` (opaque driver-private blob), `state`,
 * `createdAt`, every `quarantine*`/`foreign*`/`recovering*` field, and the `status`/`list`
 * decoration's `transitionAgeMs` -- is internal reclamation/health bookkeeping a grant recipient
 * has no business seeing, and stays off this shape. `list.get` (admin-only) still returns the
 * full `deviceRecordSchema` -- an operator inspecting the registry legitimately wants the whole
 * record. `status.get` (agent-role, ADR §3) is narrower still -- see `statusDeviceSchema` below,
 * which is what it actually returns.
 */
export const grantedDeviceSchema = z.object({
  id: z.string(),
  driverDeviceId: z.string(),
  spec: deviceSpecSchema,
  /**
   * The driver-reported address (see `DriverDevice.address`), current as of this device's
   * last `ready` transition. Undefined for a device still `provisioning` (never made ready
   * yet) and, as an upgrade path, for a record written by a pre-address daemon -- `state.json`
   * from before this field existed loads without one rather than failing to start. It becomes
   * defined the next time the device is made ready (`boot`/`readyProvisioned`); nothing here
   * ever guesses at a value it wasn't told.
   */
  address: z.string().optional(),
  /**
   * Mirrors `DriverDevice.featureProfile` (see `driver.ts`), current as of this device's last
   * `ready` transition. Undefined for a device still `provisioning` (never made ready yet)
   * and for any driver that does not reduce anything -- today's behaviour, and every non-iOS
   * driver.
   */
  featureProfile: featureProfileSchema.optional(),
});

/**
 * Mirrors `LeaseRecord` (src/core/domain.ts) field for field -- there is no decoration on top
 * of it any more. Includes `ownerId` (ADR 0003 §4): the session principal that requested the
 * lease, distinct from `requesterId` (attribution, defaults to the principal but may differ
 * per request on the same connection).
 *
 * ADR 0004: there is one kind of lease, so `mode` is gone; `ttlMs` and `lastRenewedAt` are
 * stored fields of the record rather than anything derived. `ttlMs` is the width this lease
 * was granted with, or last renewed with when a renew named one -- what a body-less
 * `lease.renew` re-applies, which is why it travels with the record instead of the caller
 * having to remember it. `lastRenewedAt` is written at grant and on every renew; it replaces
 * the old derived `lastHeartbeatAt` decoration, which was computed as `ttlDeadline -
 * heldTtlBackstopMs` and has no answer once every lease carries its own TTL.
 */
export const leaseRecordSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  requesterId: z.string(),
  ownerId: z.string(),
  grantedAt: z.number(),
  ttlMs: z.number(),
  ttlDeadline: z.number(),
  lastRenewedAt: z.number(),
});

const leaseTimingSchema = z.object({
  estimatedProvisionMs: z.number(),
  estimatedBootMs: z.number(),
  estimatedReclaimMs: z.number(),
  estimatedReadyMs: z.number(),
});

/**
 * Scoping variables a lease holder needs to reach the device it was just granted -- the
 * device-set path on iOS, the adb server port on Android (ADR 0001, decision 7). Built by the
 * driver that owns the device root and forwarded verbatim; no key here means anything to the
 * core or to this contract, which is what lets a third driver contribute its own scoping
 * without an edit here (architecture rule 2).
 */
const leaseEnvironmentSchema = z.record(z.string(), z.string());

export const leaseGrantSchema = z.object({
  device: grantedDeviceSchema,
  /**
   * Always present, `{}` at the least: containment cuts both ways, and a grant that did not
   * carry it would hand back a `driverDeviceId` no documented workflow can address.
   */
  environment: leaseEnvironmentSchema,
  lease: leaseRecordSchema,
  timing: leaseTimingSchema,
});

/**
 * The scoped command `simlock simctl` / `simlock adb` runs on the caller's behalf. The command
 * is spawned as-is, so the shape is validated at the boundary like every other output: an
 * argument list that is not entirely strings would otherwise stringify into whatever the tool
 * made of it.
 */
export const passthroughCommandSchema = z.object({
  args: z.array(z.string()),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()),
});

export const leaseProgressSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("queued"), queuePosition: z.number() }),
  z.object({ stage: z.literal("provisioning"), etaMs: z.number() }),
  z.object({ stage: z.literal("booting"), etaMs: z.number() }),
  z.object({ stage: z.literal("reclaiming"), etaMs: z.number() }),
]);

const runningCapacityEntrySchema = z.object({
  running: z.number(),
  maxRunning: z.number(),
  reserved: z.number(),
  overLimit: z.boolean(),
});

export const statusCapacitySchema = z.object({
  ios: runningCapacityEntrySchema.extend({ limit: z.number(), warm: z.number(), used: z.number() }),
  android: runningCapacityEntrySchema.extend({
    limit: z.number(),
    warm: z.number(),
    used: z.number(),
  }),
  global: runningCapacityEntrySchema.extend({ warm: z.number() }),
});

export const daemonHealthSchema = z.enum(["starting", "running", "failed"]);

export const platformCatalogSchema = z.object({
  platform: platformSchema,
  models: z.array(z.string()),
  runtimes: z.array(z.string()),
  defaultRuntime: z.string().optional(),
});

export const proposalSchema = z.object({
  action: z.enum(["shutdown", "destroy"]),
  reason: z.string(),
  rule: z.string(),
  target: z.string(),
});

export const cleanupRuleSummarySchema = z.object({ name: z.string() });

/** Mirrors `DriverDevice` (src/core/driver.ts) -- `driverData` stays opaque `unknown` on
 * purpose, exactly as the core treats it. */
const driverDeviceSchema = z.object({
  deviceId: z.string(),
  driverData: z.unknown(),
  address: z.string(),
  featureProfile: featureProfileSchema.optional(),
});

/** Mirrors the `DoctorFinding` discriminated union (src/core/doctor.ts) field for field. */
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
]);

export const doctorReportSchema = z.object({ findings: z.array(doctorFindingSchema) });

export const nukeReportSchema = z.object({
  deletedDevices: z.array(z.string()),
  releasedLeaseIds: z.array(z.string()),
});

/**
 * Mirrors `EventEnvelope` (src/bus/index.ts) at the envelope level only. `event` stays a plain
 * string and `payload` stays `z.unknown()` rather than redeclaring all ~30 `EventMap` payload
 * shapes here -- see docs/EVENTS.md for the authoritative catalog. This is a deliberate,
 * documented simplification: re-declaring every business event's payload shape a second time,
 * next to `events.md`'s existing documentation requirement, is a lot of near-duplicate surface
 * for a channel this PR does not change the routing of. Tightening this (e.g. a discriminated
 * union keyed on `event`) is left as follow-up work; flagged in the PR description.
 */
export const eventEnvelopeSchema = z.object({
  seq: z.number(),
  timestamp: z.number(),
  event: z.string(),
  payload: z.unknown(),
  module: z.string(),
});

// ---- config.get -----------------------------------------------------------------------------

const platformCapacityOptionsSchema = z.object({
  maxDevices: z.number().optional(),
  maxRunning: z.number().optional(),
});

const fixedCapacityConfigSchema = z.object({
  strategy: z.literal("fixed"),
  config: z.object({
    maxRunning: z.number(),
    ios: platformCapacityOptionsSchema.optional(),
    android: platformCapacityOptionsSchema.optional(),
  }),
});

const capacityLimitsSchema = z.object({
  maxRunning: z.number(),
  ios: z.object({ maxDevices: z.number(), maxRunning: z.number() }),
  android: z.object({ maxDevices: z.number(), maxRunning: z.number() }),
});

const resourceCapacityConfigSchema = z.object({
  strategy: z.literal("resource"),
  config: z.object({
    limits: capacityLimitsSchema,
    ramBudget: z.object({
      iosBytesPerDevice: z.number(),
      androidBytesPerDevice: z.number(),
    }),
  }),
});

/**
 * Mirrors `CapacityConfig` (src/core/capacity/strategies/index.ts), discriminated on
 * `strategy` exactly as the core type is. Adding a third strategy needs a matching edit here --
 * there is no way around that with a hand-declared contract; it is the same trade-off the ADR
 * accepts for every other core-private shape.
 */
const capacityConfigSchema = z.discriminatedUnion("strategy", [
  fixedCapacityConfigSchema,
  resourceCapacityConfigSchema,
]);

/** Mirrors `Config` (src/core/config.ts) field for field. */
export const configSchema = z.object({
  capacity: capacityConfigSchema,
  downloads: z.object({
    policy: z.enum(["never", "on-request", "always"]),
    acceptAndroidLicenses: z.boolean(),
    timeoutMs: z.number(),
  }),
  idle: z.object({
    shutdownAfterMs: z.number(),
    deleteAfterMs: z.number(),
  }),
  warmPool: z.object({
    quarantine: z.object({
      maxRetries: z.number(),
      retryBackoffMs: z.number(),
      retryBackoffMultiplier: z.number(),
      maxRetryBackoffMs: z.number(),
    }),
  }),
  lease: z.object({
    defaultTtlMs: z.number(),
    maxTtlMs: z.number(),
  }),
  exec: z.object({ timeoutMs: z.number() }),
  diskPressure: z.object({ freeBytesThreshold: z.number() }),
  eventBuffer: z.object({ capacity: z.number() }),
  log: z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
    rotateBytes: z.number(),
  }),
  http: z.object({
    enabled: z.boolean(),
    host: z.string(),
    port: z.number(),
  }),
  health: z.object({
    enabled: z.boolean(),
    probeIntervalMs: z.number(),
    stableObservations: z.number(),
    maxRecoveryAttempts: z.number(),
    recoveryBackoffMs: z.number(),
    maxConcurrentRecoveries: z.number(),
  }),
  ios: z.object({
    slim: z.object({
      enabled: z.boolean(),
      categories: z.array(z.string()).optional(),
      bootTimeoutMs: z.number(),
    }),
  }),
  stalledTransition: z.object({
    thresholdMultiplier: z.number(),
    minimumThresholdMs: z.number(),
  }),
});

// ---- tokens -----------------------------------------------------------------------------------

/**
 * `TokenRole` (agent/operator token store roles, src/http/token-store.ts) is a deliberately
 * different vocabulary from the daemon session `Role` (agent/admin, see `roles.ts`) -- a
 * `token.create --role operator` mints a credential that *resolves to* the admin session role
 * at `hello` (ADR §5), it is not itself that role. Keeping the two enums textually distinct
 * here (rather than reusing `roleSchema`) is deliberate, not an oversight.
 */
export const tokenRoleSchema = z.enum(["agent", "operator"]);

export const tokenRecordSchema = z.object({
  id: z.string(),
  role: tokenRoleSchema,
  label: z.string().optional(),
  createdAt: z.number(),
});

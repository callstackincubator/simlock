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
 * src/mcp, or src/ports -- enforced by `pnpm lint` (`.oxlintrc.json`).
 */
import { z } from "zod";

export const platformSchema = z.enum(["ios", "android"]);
export type Platform = z.infer<typeof platformSchema>;

/**
 * ADR 0015 §3: the kind of device a model is. The contract and the core name the classes; which
 * product family or tag of a platform's tools is which class lives in that platform's driver.
 */
export const deviceClassSchema = z.enum([
  "phone",
  "tablet",
  "watch",
  "tv",
  "vision",
  "auto",
  "desktop",
]);
export type DeviceClass = z.infer<typeof deviceClassSchema>;

const deviceStateSchema = z.enum([
  "provisioning",
  "ready",
  "leased",
  "reclaiming",
  "quarantined",
  "shutdown",
  "deleted",
]);

/** The mode a device actually has (ADR 0007 §9) -- the same two words on every surface. */
const deviceModeSchema = z.enum(["slim", "full"]);

const leaseIdentitySchema = z.enum(["reusable", "fresh"]);

/** The longest image tag a lease request may name. */
const IMAGE_TAG_MAX = 64;

/**
 * An image tag as a lease request names it, such as `google_apis_playstore`: the word the catalog
 * lists as an image's `tag`. Bounded here, before a driver sees it, because it arrives over the
 * wire and is stored with the request and on the device.
 */
export const imageTagSchema = z
  .string()
  .min(1)
  .max(IMAGE_TAG_MAX)
  .regex(/^[A-Za-z0-9_.-]+$/, "imageTag may contain only letters, digits, '_', '.' and '-'");

/** A device's spec as responses show it. The spec's planned mode is not shown (ADR 0007 §9): the
 * device's `mode` is the one mode a response reports. `imageTag` is shown on a device whose
 * request named one. */
const deviceSpecSchema = z.object({
  platform: platformSchema,
  model: z.string(),
  osVersion: z.string(),
  imageTag: imageTagSchema.optional(),
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
  mode: deviceModeSchema,
  leaseIdentity: leaseIdentitySchema.optional(),
  /** Decoration added by `status.get`/`list.get`; absent for a device not mid-transition. */
  transitionAgeMs: z.number().optional(),
  /** Decoration added by `status.get`/`list.get`: `true` for a device whose transition is a
   * stall by the rule `doctor` reports; absent otherwise. */
  stalled: z.boolean().optional(),
  /** Decoration added by `status.get`/`list.get` (ADR 0009 §6): whether the device's pool mode is
   * the worker's default mode for its platform. Absent on a record the registry holds. */
  servesDefaultMode: z.boolean().optional(),
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
 * - `stalled`: the stall decoration, surfaced as "stalled": a caller waiting on capacity can see
 *   that a slot is held by a transition that is not finishing.
 *
 * What stays off, and why: `driverDeviceId` (the driver address of a device the caller does
 * not hold is not actionable -- a non-owning agent cannot drive it, and a holder already gets
 * it on their grant), `driverData` (opaque driver-private blob, unbounded contents),
 * `createdAt`/`lastLeaseEndedAt` (internal bookkeeping timestamps the human formatter never
 * reads), `recoveringSince`/`recoveryAttempts` (crash-recovery bookkeeping -- `safety.md` rule
 * 2 scopes that privilege narrowly, and broadcasting its progress to every agent is not part of
 * that scope), `quarantinedAt` (superseded by `quarantineAttempts`/`quarantineNextRetryAt` for
 * what a caller needs), and `address` (only meaningful to whoever is driving the device, i.e.
 * the lease holder, who gets it on the grant). `mode` stays: which kind of device it is matters
 * to anyone reading the fleet.
 */
export const statusDeviceSchema = z.object({
  id: z.string(),
  spec: deviceSpecSchema,
  state: deviceStateSchema,
  /** The device mode (see `DeviceRecord.mode`) -- not the daemon's own `worker`/`gateway` mode. */
  mode: deviceModeSchema,
  /**
   * ADR 0009 §6: whether the device's pool mode (its spec's mode, full when it names none) is the
   * worker's default mode for the device's platform -- the pool a request naming no mode draws
   * from. The gateway reads it to tell a warm hit for such a request. Not `mode`: `mode` is what
   * the device actually is, this is what a request with no mode would get.
   */
  servesDefaultMode: z.boolean(),
  foreignStateDetectedAt: z.number().optional(),
  foreignProvenanceDetectedAt: z.number().optional(),
  quarantineAttempts: z.number().optional(),
  quarantineNextRetryAt: z.number().optional(),
  /** Decoration added by `status.get`; absent for a device not mid-transition. */
  transitionAgeMs: z.number().optional(),
  /**
   * Decoration added by `status.get`: `true` for a device stuck `provisioning` or `reclaiming`
   * past its threshold, by the rule `doctor`'s `stalled-transition` finding uses; absent for
   * every other device. A worker view copies it, so a gateway reports a worker's stall as the
   * worker does.
   */
  stalled: z.boolean().optional(),
  /**
   * ADR 0005 §20: which worker this device lives on. Additive and gateway-only -- a worker
   * answers `status.get` about its own devices and has no second machine to name, so it never
   * sets this; a gateway sets it on every device in the aggregate, because "device dev_7" is
   * ambiguous across a fleet in a way it never is on one host.
   */
  workerId: z.string().optional(),
});

/**
 * The device a `lease.request`/`lease.renew` grant carries -- deliberately narrower than
 * `deviceRecordSchema` (ADR 0003 §1: "the daemon maps [core records] onto contract types in
 * exactly one place"). A grant is agent-facing, not an admin inspection of the registry, so it
 * carries only what a caller needs to drive the device it was just handed:
 *
 * - `id`: the lease-facing device identity (what `lease.list`/`lease.renew` correlate against).
 * - `driverDeviceId`: the driver address a caller actually drives (simctl UDID / adb serial).
 * - `spec`, `address`, `mode`: same meanings as on `DeviceRecord` (src/core/domain.ts).
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
   * defined the next time the device is made ready (`bootForLease`/`readyProvisionedForLease`);
   * nothing here ever guesses at a value it wasn't told.
   */
  address: z.string().optional(),
  /** The mode the device actually has (see `DeviceRecord.mode`). */
  mode: deviceModeSchema,
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
  /**
   * ADR 0005 §18: "the lease object gains `worker: { id, label }` (additive) so a client and
   * the console can tell where the device lives. A worker's network address is never exposed."
   * Additive and gateway-only -- a worker granting its own local lease has no second machine to
   * name and never sets this; a gateway stamps it on every lease it forwards a grant/renew for,
   * using the same worker id `id` already encodes (§16: a gateway lease id is
   * `<workerId>.<workerLeaseId>`) plus the worker's display `label`, when it has one, for a
   * console to render without a second lookup.
   */
  worker: z.object({ id: z.string(), label: z.string().optional() }).optional(),
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

/** The device a lease request named, with every field it left out left out. */
const requestedDeviceSchema = z.object({
  platform: platformSchema,
  /** Present only when the request named a model; one that named a class or nothing has none. */
  model: z.string().optional(),
  class: deviceClassSchema.optional(),
  osVersion: z.string().optional(),
  mode: deviceModeSchema.optional(),
  imageTag: imageTagSchema.optional(),
});

/**
 * One stored lease request (`LeaseRequestRecord`, src/core/domain.ts): the shape a frontend reads
 * a request back in, whichever frontend sent it. `grant` is the grant the request was answered
 * with, stored as granted -- a later renew does not move its `ttlDeadline`.
 */
export const leaseRequestRecordSchema = z.object({
  id: z.string(),
  requesterId: z.string(),
  ownerId: z.string(),
  idempotencyKey: z.string().optional(),
  request: requestedDeviceSchema,
  createdAt: z.number(),
  state: z.enum(["open", "granted", "failed", "cancelled"]),
  settledAt: z.number().optional(),
  grant: leaseGrantSchema.optional(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
});

/**
 * A request still waiting for a device (`list.get` with `requests`, `status.get`'s `waiting`).
 * `stage` is `queued` while the request holds a place in the queue, with that place in
 * `queuePosition`, counted from 1 the way `lease.queued` counts it; `starting` while the daemon is
 * working on it: placing it as it arrives, or finding, making, booting or downloading a device
 * for it. `workerId` names the worker whose own queue
 * the request waits in; only a gateway sets it. The request's idempotency key and owner are
 * never part of it: a key lets its holder replay the request, and neither is the operator's.
 */
export const waitingRequestSchema = z.object({
  id: z.string(),
  requesterId: z.string(),
  spec: requestedDeviceSchema,
  createdAt: z.number(),
  stage: z.enum(["queued", "starting"]),
  queuePosition: z.number().int().positive().optional(),
  workerId: z.string().optional(),
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
  // ADR 0010 §3: the request waits on a component download. Bounded here so a gateway checks a
  // worker's push before relaying it (safety rule 10).
  z.object({
    stage: z.literal("downloading"),
    component: z.string().max(64),
    waiting: z.boolean(),
    percent: z.number().int().min(0).max(100).optional(),
  }),
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

/**
 * One platform's entry. `atRamBudget`: creating one more full device of the platform would be
 * refused for RAM -- the check the planner makes, so a gateway can pass such a worker over
 * (ADR 0009 §7). Always `false` under a strategy that keeps no RAM budget.
 */
const platformCapacityEntrySchema = runningCapacityEntrySchema.extend({
  limit: z.number(),
  warm: z.number(),
  used: z.number(),
  atRamBudget: z.boolean(),
});

export const statusCapacitySchema = z.object({
  ios: platformCapacityEntrySchema,
  android: platformCapacityEntrySchema,
  global: runningCapacityEntrySchema.extend({ warm: z.number() }),
  /** Present only under a strategy that keeps a RAM budget. `usedBytes` counts every
   * non-deleted device by the mode it reports, without in-flight provisioning. */
  ramBudget: z
    .object({
      limitBytes: z.number().finite(),
      usedBytes: z.number().finite().nonnegative(),
      overLimit: z.boolean(),
    })
    .optional(),
});

export const daemonHealthSchema = z.enum(["starting", "running", "failed"]);

/**
 * Limits on the catalog's other names and images. A worker's catalog is a claim the gateway
 * parses off the wire, so every string and list in these fields has a bound well above any
 * real host (an SDK ships some 70 device profiles and a few dozen images).
 */
const CATALOG_NAME_MAX = 256;
const CATALOG_ALIASES_PER_MODEL_MAX = 32;
const CATALOG_ALIASED_MODELS_MAX = 4096;
const CATALOG_IMAGE_FIELD_MAX = 128;
const CATALOG_IMAGES_MAX = 1024;
/** `customModels` is a subset of `models`; it takes the bound already on a per-model list. */
const CATALOG_CUSTOM_MODELS_MAX = CATALOG_ALIASED_MODELS_MAX;

/**
 * The list bounds above, for a producer that merges lists the schema checked one by one: a
 * gateway's union of valid worker catalogs must itself fit, or its own clients refuse it.
 */
export const CATALOG_LIST_LIMITS = {
  aliasedModels: CATALOG_ALIASED_MODELS_MAX,
  aliasesPerModel: CATALOG_ALIASES_PER_MODEL_MAX,
  customModels: CATALOG_CUSTOM_MODELS_MAX,
  images: CATALOG_IMAGES_MAX,
} as const;

const catalogImageSchema = z.object({
  runtime: z.string().max(CATALOG_IMAGE_FIELD_MAX),
  tag: z.string().max(CATALOG_IMAGE_FIELD_MAX),
  abi: z.string().max(CATALOG_IMAGE_FIELD_MAX),
});

/**
 * ADR 0008 §5: what machine a daemon runs on. Every string and the `tools` list are bounded,
 * because a gateway stores what each worker reports in that worker's view (safety rule 10).
 */
const MAX_HOST_STRING_LENGTH = 128;
const MAX_HOST_TOOLS = 32;
const hostStringSchema = z.string().min(1).max(MAX_HOST_STRING_LENGTH);

export const hostFactsSchema = z.object({
  /** Operating system product name (`macOS`), or the kernel name where there is none. */
  os: hostStringSchema,
  osVersion: hostStringSchema,
  /** CPU architecture as Node names it (`arm64`, `x64`). */
  arch: hostStringSchema,
  /** The platform tools each driver uses, with the version installed. Empty on a gateway, which
   * runs no drivers. */
  tools: z
    .array(
      z.object({
        platform: platformSchema,
        name: hostStringSchema,
        version: hostStringSchema,
        build: hostStringSchema.optional(),
      }),
    )
    .max(MAX_HOST_TOOLS),
});

/** The shape `fitHostFacts` reads: the core's own host facts type and this schema's both fit. */
interface HostFactsShape {
  readonly arch: string;
  readonly os: string;
  readonly osVersion: string;
  readonly tools: readonly unknown[];
}

/**
 * Brings host facts a daemon read from its own machine within `hostFactsSchema`'s bounds, so an
 * odd value cannot fail the daemon's own `status.get` output check and take its liveness probe
 * down (ADR 0008 §7). A tool that does not fit is left out, like one that cannot be read; a host
 * string that does not fit is cut to length; the list stops at its maximum. Lives beside the
 * schema so the bounds are written once.
 */
export function fitHostFacts<Host extends HostFactsShape>(host: Host): Host {
  const fit = (value: string) => value.slice(0, MAX_HOST_STRING_LENGTH);
  const tool = hostFactsSchema.shape.tools.element;
  return {
    ...host,
    arch: fit(host.arch),
    os: fit(host.os),
    osVersion: fit(host.osVersion),
    tools: host.tools.filter((entry) => tool.safeParse(entry).success).slice(0, MAX_HOST_TOOLS),
  };
}

export const platformCatalogSchema = z.object({
  platform: platformSchema,
  models: z.array(z.string()),
  runtimes: z.array(z.string()),
  defaultRuntime: z.string().optional(),
  /**
   * ADR 0008 §1: for each name in `models`, the installed runtimes it pairs with -- every pair
   * listed here can be leased. An empty list means no installed runtime pairs with that model.
   * On a gateway this is the union of each connected worker's own list for the model, never
   * the cross product of fleet models and fleet runtimes.
   */
  modelRuntimes: z.record(z.string(), z.array(z.string())),
  /**
   * ADR 0008 §1: for a name in `models`, the other names a lease request may use for it, in any
   * letter case -- a device id a driver accepts beside a display name. Only models that have another
   * name appear. On a gateway it is the union per model of what each worker lists.
   */
  modelAliases: z
    .record(
      z.string().max(CATALOG_NAME_MAX),
      z.array(z.string().max(CATALOG_NAME_MAX)).max(CATALOG_ALIASES_PER_MODEL_MAX),
    )
    .refine((aliases) => Object.keys(aliases).length <= CATALOG_ALIASED_MODELS_MAX, {
      message: `modelAliases lists more than ${CATALOG_ALIASED_MODELS_MAX} models`,
    }),
  /**
   * ADR 0015 §3: for a name in `models`, its class, when the platform's tools report one. A model
   * the tools say nothing usable about has no entry. On a gateway it is the union over the
   * connected workers; when two workers class a model differently, the first worker in id order
   * wins.
   */
  modelClasses: z
    .record(z.string().max(CATALOG_NAME_MAX), deviceClassSchema)
    .refine((classes) => Object.keys(classes).length <= CATALOG_ALIASED_MODELS_MAX),
  /**
   * ADR 0015 §4: for a class, the model Simlock would create for it on this host -- of the
   * names on the class's preference list that `models` lists and that are of the class, the
   * first that pairs with an installed runtime, else the first of them. A class in which no
   * listed model counts has no entry. On a gateway a class's entry is kept only when every
   * connected worker reports the same model for it, and that worker lists it itself.
   */
  classDefaults: z.record(deviceClassSchema, z.string().max(CATALOG_NAME_MAX)),
  /**
   * ADR 0008 §1: every installed image, present only for a platform whose driver has images
   * (Android). `runtime` is a value from `runtimes`; an image of an ABI the host cannot run
   * natively is listed too. On a gateway it is the union by runtime, tag, and ABI.
   */
  images: z.array(catalogImageSchema).max(CATALOG_IMAGES_MAX).optional(),
  /**
   * Names from `models` that exist because of something on this machine rather than the
   * platform's tools -- on Android, a custom profile from Android Studio's `devices.xml`.
   * Absent when there are none. On a gateway a model is listed when any worker that lists it
   * marks it custom.
   */
  customModels: z.array(z.string().max(CATALOG_NAME_MAX)).max(CATALOG_CUSTOM_MODELS_MAX).optional(),
  /**
   * ADR 0005 §21: on a gateway, `models`/`runtimes` are the *union* over the fleet, and these
   * two maps say which workers each entry came from (`{"iPhone 16": ["wrk_a", "wrk_b"]}`).
   * Additive and gateway-only: a worker's own catalog needs no attribution, and a renderer
   * that predates the fleet still reads `models`/`runtimes` unchanged. Kept as annotations
   * beside the flat lists rather than as a change to their element type precisely so that
   * stays true.
   */
  modelWorkers: z.record(z.string(), z.array(z.string())).optional(),
  runtimeWorkers: z.record(z.string(), z.array(z.string())).optional(),
});

/**
 * Brings a catalog entry a daemon built from its own machine within `customModels`' bounds, so
 * a custom profile name the platform's tools never checked cannot fail the whole `catalog.get`
 * answer. A name that does not fit loses its mark and stays in `models`; the list stops at its
 * maximum, and an empty list is left out. Lives beside the schema so the bounds are written once.
 */
export function fitPlatformCatalog<
  Entry extends {
    readonly customModels?: readonly string[];
    readonly modelClasses?: Readonly<Record<string, DeviceClass>>;
    readonly classDefaults?: Readonly<Partial<Record<DeviceClass, string>>>;
  },
>(entry: Entry): Entry {
  const { classDefaults, customModels, modelClasses, ...rest } = entry;
  const fitting = (customModels ?? [])
    .filter((model) => model.length <= CATALOG_NAME_MAX)
    .slice(0, CATALOG_CUSTOM_MODELS_MAX);
  return {
    ...rest,
    ...(modelClasses === undefined
      ? {}
      : {
          modelClasses: Object.fromEntries(
            Object.entries(modelClasses).filter(([model]) => model.length <= CATALOG_NAME_MAX),
          ),
        }),
    ...(classDefaults === undefined
      ? {}
      : {
          classDefaults: Object.fromEntries(
            Object.entries(classDefaults).filter(([, model]) => model.length <= CATALOG_NAME_MAX),
          ),
        }),
    ...(fitting.length === 0 ? {} : { customModels: fitting }),
  } as unknown as Entry;
}

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
  mode: deviceModeSchema.optional(),
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
  z.object({
    kind: z.literal("prerequisite-missing"),
    platform: platformSchema,
    prerequisite: z.string(),
    message: z.string(),
    remedy: z.string(),
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
 * shapes here -- see docs/internal/EVENTS.md for the authoritative catalog. This is a deliberate,
 * documented simplification: re-declaring every business event's payload shape a second time,
 * next to `events.md`'s existing documentation requirement, is a lot of near-duplicate surface
 * for a channel this PR does not change the routing of. Tightening this (e.g. a discriminated
 * union keyed on `event`) is left as follow-up work; flagged in the PR description.
 */
/** The largest magnitude, in ms, a JavaScript `Date` holds. */
const MAX_DATE_MS = 8.64e15;

export const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_-]{1,64}$/;

export const eventEnvelopeSchema = z.object({
  /** Wire input is a claim (safety.md): a pushed `id` is bounded, not trusted. */
  id: z.string().regex(EVENT_ID_PATTERN),
  seq: z.number(),
  /** A claim, bounded to the range a JavaScript date holds so the console can render it. */
  timestamp: z.number().min(-MAX_DATE_MS).max(MAX_DATE_MS),
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
      iosSlimBytesPerDevice: z.number().optional(),
      androidBytesPerDevice: z.number(),
      androidSlimBytesPerDevice: z.number().optional(),
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
/** ADR 0015 §4: `ios.defaultModels` and `android.defaultModels`, a list of model names per class. */
const defaultModelsSchema = z.record(deviceClassSchema, z.array(z.string().min(1)).min(1));

export const configSchema = z.object({
  /** ADR 0005 §1. `config.get` is how a caller learns which mode the daemon it is talking to
   * runs in without inferring it from behaviour; `status.get`'s `daemon.mode` is the
   * agent-role answer to the same question. */
  mode: z.enum(["worker", "gateway"]),
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
    enabled: z.boolean(),
    reserveRunning: z.object({ ios: z.number(), android: z.number() }),
    maxConcurrentBoots: z.number(),
    targets: z.array(
      z.object({
        platform: z.enum(["ios", "android"]),
        model: z.string(),
        osVersion: z.string().optional(),
        mode: z.enum(["slim", "full"]).optional(),
        count: z.number(),
      }),
    ),
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
    identity: z.object({
      ios: leaseIdentitySchema,
      android: leaseIdentitySchema,
    }),
    requestRetentionMs: z.number(),
    maxRequestRecords: z.number(),
  }),
  exec: z.object({ timeoutMs: z.number() }),
  diskPressure: z.object({ freeBytesThreshold: z.number() }),
  eventBuffer: z.object({ capacity: z.number() }),
  log: z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
    rotateBytes: z.number(),
  }),
  // Optional: a newer gateway parses this from an older worker's `config.get`.
  eventLog: z
    .object({
      rotateBytes: z.number(),
      retention: z.number().optional(),
      maxBytes: z.number().optional(),
    })
    .optional(),
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
    defaultMode: deviceModeSchema,
    defaultModels: defaultModelsSchema,
    slim: z.object({
      categories: z.array(z.string()).optional(),
      bootTimeoutMs: z.number(),
    }),
  }),
  android: z.object({
    defaultModels: defaultModelsSchema,
    emulator: z.object({
      headless: z.boolean(),
      gpu: z.string().min(1),
      audio: z.boolean(),
      bootAnimation: z.boolean(),
    }),
  }),
  /** ADR 0005 §3/§6. `url`/`token`/`label` are the worker's half, `disconnectedRetentionMs`
   * the gateway's; a daemon carries the whole block whichever mode it runs in, and simply
   * reads the half that applies (see `Config["gateway"]`). */
  gateway: z.object({
    url: z.string().optional(),
    token: z.string().optional(),
    label: z.string().optional(),
    disconnectedRetentionMs: z.number(),
    execTimeoutMs: z.number(),
    /** ADR 0005 §29/P2: the forwarded `lease.request`'s own bound. Round 6 review: this was
     * declared on `Config`, validated by `loadConfig`, and documented in CONFIGURATION.md, but
     * missing here -- and since this schema is `config.get`'s declared output, zod stripped it,
     * so an operator inspecting the effective config saw every other gateway key and concluded
     * this one did not exist. `config.test.ts` now parses a loaded config through this schema
     * and compares key sets, so the next such omission fails rather than disappears. */
    leaseRequestTimeoutMs: z.number(),
    /** ADR 0005 §13/Decision 7: which routing policy dispatch uses. Gateway-side, read once at
     * construction like `capacity.strategy` -- never a per-request choice. The set of names is
     * re-declared here rather than imported from `src/gateway/routing.ts`'s own registry, the
     * same way `capacityConfigSchema` above re-declares "fixed"/"resource" instead of importing
     * `src/core/capacity`'s: this module describes wire shapes and imports no engine (its own
     * header comment), gateway or worker alike. `"warm-then-free"` is the only policy in v1;
     * adding a second means adding it to both registries, exactly as a capacity strategy does. */
    routing: z.enum(["warm-then-free"]),
  }),
  stalledTransition: z.object({
    thresholdMultiplier: z.number(),
    minimumThresholdMs: z.number(),
  }),
});

// ---- tokens -----------------------------------------------------------------------------------

/**
 * `TokenRole` (agent/operator/worker token store roles, src/http/token-store.ts) is a
 * deliberately different vocabulary from the daemon session `Role` (agent/admin, see
 * `roles.ts`) -- a `token.create --role operator` mints a credential that *resolves to* the
 * admin session role at `hello` (ADR 0003 §5), it is not itself that role. Keeping the two
 * enums textually distinct here (rather than reusing `roleSchema`) is deliberate, not an
 * oversight.
 *
 * ADR 0005 §8/§25 adds `worker`: a join token, presented by a worker when it opens its uplink
 * to a gateway. It resolves to no session role at all -- it can open an uplink and nothing
 * else, and a `worker`-role token on a `/v1` route is `403` (see `src/http/auth.ts`). That is
 * why it is a third value here rather than a reuse of `agent`: the whole point is a credential
 * whose authority is a single transport, not a set of operations.
 */
export const tokenRoleSchema = z.enum(["agent", "operator", "worker"]);

export const tokenRecordSchema = z.object({
  id: z.string(),
  role: tokenRoleSchema,
  label: z.string().optional(),
  createdAt: z.number(),
});

// ---- modes and worker views (ADR 0005) --------------------------------------------------------

/**
 * Which mode a daemon runs in (ADR 0005 §1). A worker owns devices -- drivers, registry,
 * capacity, leases -- and is what every simlock daemon has been until now, so it is the
 * default. A gateway owns none of that and fronts the workers connected to it. One process,
 * one mode.
 */
export const daemonModeSchema = z.enum(["worker", "gateway"]);

/** Mirrors `ProtocolRange` (protocol.ts). Re-declared rather than imported so this file stays
 * the one place a wire *shape* is written down; `protocol.ts` owns the negotiation logic. */
const protocolRangeShapeSchema = z.object({ min: z.number().int(), max: z.number().int() });

/**
 * ADR 0005 §6: the uplink is the reachability signal. `connected` means the worker's uplink is
 * open and its session negotiated a protocol version; `disconnected` means it closed and the
 * view is the last-known one (kept until `gateway.disconnectedRetentionMs` elapses or an
 * operator removes it); `incompatible` means the uplink is open but `hello` found no
 * overlapping protocol version (§31) -- the view then carries both ranges and nothing else the
 * gateway would have had to ask for over a protocol it cannot speak.
 */
const workerConnectionStateSchema = z.enum(["connected", "disconnected", "incompatible"]);

// ---- installs in progress (ADR 0010 §3) ---------------------------------------------------

const MAX_LISTED_INSTALLS = 16;
const MAX_INSTALL_COMPONENT_LENGTH = 64;

/**
 * One component install a daemon has waiting or running. A worker's list reaches the gateway as
 * a claim (safety rule 10), so the bounds cut rather than refuse: an over-long list keeps its
 * first (oldest) 16 entries and an over-long `component` its first 64 characters, and the view
 * stays usable instead of failing its whole refresh over one field.
 */
const installInProgressSchema = z.object({
  platform: platformSchema,
  /** As the daemon's driver named it: a version, or a word such as "newest". */
  component: z.string().transform((value) => value.slice(0, MAX_INSTALL_COMPONENT_LENGTH)),
  /** `waiting` behind another install on its platform, or `downloading`. */
  state: z.enum(["waiting", "downloading"]),
  /** When the first call for this install arrived. */
  since: z.number(),
  /** How many calls are joined to it. */
  waiters: z.number().int().nonnegative(),
});

/** A list of at most `MAX_LISTED_INSTALLS` entries; a longer one is cut to its first ones. */
function boundedInstalls<Entry extends z.ZodTypeAny>(entry: Entry) {
  return z.array(entry).transform((installs) => installs.slice(0, MAX_LISTED_INSTALLS));
}

/** A worker view's installs: the worker's own `status.get` list, copied (ADR 0010 §7). */
const workerInstallsSchema = boundedInstalls(installInProgressSchema);

/** `status.get`'s installs. On a gateway each entry names the worker it runs on. */
export const statusInstallsSchema = boundedInstalls(
  installInProgressSchema.extend({ workerId: z.string().optional() }),
);

/**
 * The bound above, for a producer that merges lists the schema checked one by one: a gateway's
 * fleet list must itself fit, or the schema cuts it wherever the merge left it.
 */
export const INSTALL_LIST_LIMIT = MAX_LISTED_INSTALLS;

/**
 * What the gateway currently knows about one worker (ADR 0005's vocabulary table, §7, §31).
 * Rebuilt over the uplink, never persisted: a gateway restart re-derives every field from the
 * workers that reconnect (§30).
 *
 * The optional fields are exactly the ones that come from a `status.get`/`catalog.get` round
 * trip the gateway may not have been able to make: an `incompatible` worker is never asked
 * anything, and a `disconnected` view keeps whatever the last successful refresh saw. They are
 * absent rather than zeroed on purpose -- "no capacity reported" and "no capacity free" are
 * different facts, and a console that dims one must not read the other as a full machine.
 * The same holds for a worker whose health is `starting`: it answers `status.get` with `daemon`
 * and `host` only, so its view has `health` and `host` and none of `capacity`, `catalog`,
 * `devices`, `installs`, `leases`, `queueDepth` or `waiting` -- never empty ones, which would
 * read as "nothing is leased" about a registry nobody has checked yet.
 *
 * A worker answers `worker.list` with one of these about itself (ADR 0012 §1): `connected`,
 * never drained, `lastSeenAt` the time of the call, and every reported field filled from its
 * own reads by `workerViewFields` (`worker-view.ts`), the same builder a gateway uses.
 */
export const workerViewSchema = z.object({
  /** The worker's own instance identity (`instance.json`), ADR 0005 §3a: stable across
   * restarts, unique by construction, opaque to clients. Never a host name or an address. */
  id: z.string(),
  /** `gateway.label` from the worker's config -- display only, need not be unique, and never
   * used to route (§13: "label is display-only"). */
  label: z.string().optional(),
  connection: workerConnectionStateSchema,
  /** ADR 0005 §9: a drained worker keeps its leases and receives no new dispatches. */
  drained: z.boolean(),
  /** When the gateway last had this worker's uplink open, or last refreshed its view. */
  lastSeenAt: z.number(),
  health: daemonHealthSchema.optional(),
  /** The worker daemon's own version string, as reported by its `hello` reply. */
  version: z.string().optional(),
  /** Set only for an `incompatible` worker (§31), naming both ranges so an operator can see
   * which side to upgrade. */
  protocol: z
    .object({ gateway: protocolRangeShapeSchema, worker: protocolRangeShapeSchema })
    .optional(),
  capacity: statusCapacitySchema.optional(),
  /**
   * The worker's effective `downloads.policy`, read once with `config.get` when the uplink
   * connects. Display only: routing counts installed runtimes and never reads it, and the
   * gateway forwards every request with `allowDownload: false` (ADR 0009 §3). Absent for a
   * worker whose `config.get` the gateway could not read (an incompatible one, or a call that
   * failed).
   */
  downloads: z
    .object({
      policy: z.enum(["never", "on-request", "always"]),
      /** The worker's own `downloads.timeoutMs`, read with the policy (ADR 0010 §7). Optional
       * so a gateway on an older build still parses a view. */
      timeoutMs: z.number().optional(),
    })
    .optional(),
  /**
   * The worker's own `lease.maxTtlMs`, read once with `config.get` when the uplink connects
   * (and again on the periodic backstop tick, alongside the catalog and `downloads.policy`
   * above -- see `WorkerLink#rebuildView`). ADR 0005 §15: a fleet lease's width is decided at
   * the gateway's own `lease.maxTtlMs`, but what the gateway dispatches is an ordinary
   * `lease.request`, so a worker whose own cap is lower still refuses a request the gateway
   * already accepted -- this field is what lets the gateway notice that at the worker, rather
   * than only in the operator's documentation. Absent for a worker whose `config.get` the
   * gateway could not read (an incompatible worker, a call that failed, or one older than this
   * field).
   */
  lease: z.object({ maxTtlMs: z.number() }).optional(),
  /** The worker's *own* queue depth -- local agents on that machine. The gateway's fleet queue
   * is reported separately by `status.get` and arrives with #118. */
  queueDepth: z.number().optional(),
  leases: z.array(leaseRecordSchema).optional(),
  devices: z.array(statusDeviceSchema).optional(),
  catalog: z.array(platformCatalogSchema).optional(),
  /**
   * ADR 0009 §4: when the gateway last read `catalog` from this worker in its current session.
   * Cleared when the worker connects and set again by the first refresh that reads a catalog, so
   * a worker that has just connected has none: its `catalog` is the last session's, or absent.
   * It is what tells a catalog read and found empty from one that has not arrived. Absent on a
   * view no gateway built.
   */
  catalogReadAt: z.number().optional(),
  /** ADR 0008 §8: the `host` block of the worker's last `status.get`. Absent for a worker the
   * gateway has not read status from, and for an `incompatible` one. */
  host: hostFactsSchema.optional(),
  /** ADR 0010 §7: the `installs` of the worker's last `status.get`. Empty for a worker whose
   * status lists none, including one too old to list them. */
  installs: workerInstallsSchema.optional(),
  /** The `waiting` of the worker's last `status.get`: the requests waiting in its own queue,
   * copied as `installs` is. Empty for a worker too old to list them; absent for a
   * disconnected or incompatible one, which the gateway cannot ask. */
  waiting: z.array(waitingRequestSchema).optional(),
});

/**
 * `status.get`'s lease shape. Identical to `leaseRecordSchema` plus the gateway's additive
 * `workerId` (ADR 0005 §20) -- an extension rather than a change to `leaseRecordSchema` itself,
 * so `lease.renew`/`lease.list`'s shapes are untouched by this PR.
 */
export const statusLeaseSchema = leaseRecordSchema.extend({
  /** Which worker holds this lease; absent on a worker's own answer, set by a gateway. */
  workerId: z.string().optional(),
});

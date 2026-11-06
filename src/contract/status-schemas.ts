import { z } from "zod";

import {
  baselineEntrySchema,
  baselineNameSchema,
  type DeviceClass,
  deviceClassSchema,
  imageTagSchema,
  platformSchema,
  statusDeviceSchema,
} from "./device-schemas.js";
import { leaseRecordSchema, waitingRequestSchema } from "./lease-schemas.js";
import { CONTROL_CHARACTERS, deviceModeSchema } from "./schema-parts.js";

const runningCapacityEntrySchema = z.object({
  running: z.number(),
  maxRunning: z.number(),
  reserved: z.number(),
  overLimit: z.boolean(),
});

const platformCapacityEntrySchema = runningCapacityEntrySchema.extend({
  limit: z.number(),
  warm: z.number(),
  used: z.number(),
  atRamBudget: z.boolean(),
});

const memoryPressureStepSchema = z.enum(["none", "warming-paused", "new-devices-paused"]);

/** why: the reading that turned the current step on; a floor trigger names the floor it fell under. */
const memoryPressureCauseSchema = z.object({
  trigger: z.enum(["level", "floor"]),
  availablePercent: z.number().int().min(0).max(100),
  level: z.enum(["normal", "warn", "critical"]).optional(),
  floorPercent: z.number().min(0).max(100).optional(),
});

export const statusMemoryPressureSchema = z.object({
  step: memoryPressureStepSchema,
  since: z.number().finite().nonnegative().optional(),
  cause: memoryPressureCauseSchema.optional(),
});

export type StatusMemoryPressure = z.infer<typeof statusMemoryPressureSchema>;

export const statusCapacitySchema = z.object({
  ios: platformCapacityEntrySchema,
  android: platformCapacityEntrySchema,
  global: runningCapacityEntrySchema.extend({ warm: z.number() }),
  /** why: present only under a strategy that keeps a RAM budget. `usedBytes` counts every
   * device neither deleted nor shut down, by the mode it reports, without in-flight provisioning. */
  ramBudget: z
    .object({
      limitBytes: z.number().finite(),
      usedBytes: z.number().finite().nonnegative(),
      overLimit: z.boolean(),
    })
    .optional(),
  /** why: present only while host load is on and a reading has been taken. */
  memoryPressure: statusMemoryPressureSchema.optional(),
});

/** why: a gateway parses the warm pool block off the wire from every worker, so it is bounded. */
/** why: the most configured targets the config load accepts (the block itself takes `WARM_POOL_ENTRIES_MAX`), and the longest model or OS version the block names. */
export const WARM_POOL_TARGETS_MAX = 256;
export const WARM_POOL_NAME_MAX = 256;
/** why: the most learned kinds the pool keeps per platform, so the most one `warm.forget` answers (a match names one platform). */
export const WARM_POOL_LEARNED_KINDS_MAX = 32;
/** why: the configured targets plus the learned kinds of both platforms the pool keeps. */
const WARM_POOL_ENTRIES_MAX = WARM_POOL_TARGETS_MAX + 2 * WARM_POOL_LEARNED_KINDS_MAX;

const warmPoolShortSchema = z.enum([
  "disabled",
  "no-driver",
  "runtime-missing",
  "unknown-model",
  "unresolvable",
  "boot-failed",
  "device-limit",
  "running-limit",
  "reserve",
  "ram-budget",
]);

const warmPoolTargetSchema = z.object({
  platform: platformSchema,
  model: z.string().max(WARM_POOL_NAME_MAX),
  osVersion: z.string().max(WARM_POOL_NAME_MAX).optional(),
  mode: z.enum(["slim", "full"]),
  imageTag: imageTagSchema.optional(),
  baseline: baselineNameSchema.optional(),
  origin: z.enum(["configured", "learned"]),
  count: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  booting: z.number().int().nonnegative(),
  short: warmPoolShortSchema.optional(),
});

export const statusWarmPoolSchema = z.object({
  enabled: z.boolean(),
  reserveRunning: z.object({
    ios: z.number().int().nonnegative(),
    android: z.number().int().nonnegative(),
  }),
  targets: z.array(warmPoolTargetSchema).max(WARM_POOL_ENTRIES_MAX),
});

export const daemonHealthSchema = z.enum(["starting", "running", "failed"]);

const UPDATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const UPDATE_VERSION_MAX = 64;
const UPDATE_MESSAGE_MAX = 2000;
const updateVersionSchema = z.string().max(UPDATE_VERSION_MAX);

export const updateRequestedVersionSchema = updateVersionSchema.regex(UPDATE_VERSION_PATTERN);

const updateStateBase = {
  from: updateVersionSchema,
  to: updateVersionSchema,
  forced: z.boolean(),
  startedAt: z.number().int().min(0),
};

const updateStateSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("waiting"), leases: z.number().int().min(0), ...updateStateBase }),
  z.object({ stage: z.literal("installing"), ...updateStateBase }),
  z.object({ stage: z.literal("restarting"), ...updateStateBase }),
]);

export const updateFailureSchema = z.object({
  stage: z.enum(["installing", "restarting"]),
  from: updateVersionSchema,
  to: updateVersionSchema,
  message: z.string().max(UPDATE_MESSAGE_MAX),
  at: z.number().int().min(0),
});

export type UpdateState = z.infer<typeof updateStateSchema>;
export type UpdateFailure = z.infer<typeof updateFailureSchema>;

export const daemonUpdateFields = {
  version: updateVersionSchema,
  update: updateStateSchema.nullable(),
  lastUpdateFailure: updateFailureSchema.nullable(),
  latestVersion: updateVersionSchema.nullable(),
};

const CATALOG_NAME_MAX = 256;
const CATALOG_ALIASES_PER_MODEL_MAX = 32;
const CATALOG_ALIASED_MODELS_MAX = 4096;
const CATALOG_IMAGE_FIELD_MAX = 128;
const CATALOG_IMAGES_MAX = 1024;
const CATALOG_CUSTOM_MODELS_MAX = CATALOG_ALIASED_MODELS_MAX;

const CATALOG_SLIM_CATEGORIES_MAX = 32;

/**
 * why: the list bounds above, for a producer that merges lists the schema checked one by one: a
 * gateway's union of valid worker catalogs must itself fit, or its own clients refuse it.
 */
export const CATALOG_LIST_LIMITS = {
  aliasedModels: CATALOG_ALIASED_MODELS_MAX,
  aliasesPerModel: CATALOG_ALIASES_PER_MODEL_MAX,
  customModels: CATALOG_CUSTOM_MODELS_MAX,
  images: CATALOG_IMAGES_MAX,
  slimCategories: CATALOG_SLIM_CATEGORIES_MAX,
} as const;

const catalogImageSchema = z.object({
  runtime: z.string().max(CATALOG_IMAGE_FIELD_MAX),
  tag: z.string().max(CATALOG_IMAGE_FIELD_MAX),
  abi: z.string().max(CATALOG_IMAGE_FIELD_MAX),
});

const MAX_HOST_STRING_LENGTH = 128;
const MAX_HOST_TOOLS = 32;
const hostStringSchema = z.string().min(1).max(MAX_HOST_STRING_LENGTH);

export const hostFactsSchema = z.object({
  os: hostStringSchema,
  osVersion: hostStringSchema,
  arch: hostStringSchema,
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

interface HostFactsShape {
  readonly arch: string;
  readonly os: string;
  readonly osVersion: string;
  readonly tools: readonly unknown[];
}

/**
 * why: brings host facts a daemon read from its own machine within `hostFactsSchema`'s bounds, so
 * an odd value cannot fail the daemon's own `status.get` output check and take its liveness probe
 * down (ADR 0008 §7). Lives beside the schema so the bounds are written once.
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

const MAX_LOAD_AGE_MS = 86_400_000;
const loadNumber = z.number().finite().nonnegative();
const loadCpuSchema = z.object({
  busyPercent: loadNumber.max(100),
  cores: loadNumber.positive(),
  limited: z.boolean(),
});
const loadMemorySchema = z.object({
  totalBytes: loadNumber,
  availableBytes: loadNumber,
  swapUsedBytes: loadNumber,
  pressure: z.enum(["normal", "warn", "critical"]).optional(),
  limited: z.boolean(),
});
const loadDiskSchema = z.object({ freeBytes: loadNumber, totalBytes: loadNumber });

export const hostLoadSchema = z.object({
  ageMs: z.number().int().min(0).max(MAX_LOAD_AGE_MS),
  cpu: loadCpuSchema.optional(),
  memory: loadMemorySchema.optional(),
  disk: loadDiskSchema.optional(),
});

// why: a view stores when the load was read (`readAt`, the viewer's clock), not its age, so the age stays right as the view sits.
const workerLoadSchema = z.object({
  readAt: z.number().int().min(0),
  cpu: loadCpuSchema.optional(),
  memory: loadMemorySchema.optional(),
  disk: loadDiskSchema.optional(),
});

export type StatusLoad = z.infer<typeof hostLoadSchema>;

/**
 * why: brings a reading within `hostLoadSchema`'s bounds, so an odd figure cannot fail the
 * daemon's own `status.get` output check (ADR 0029 §4).
 */
export function fitHostLoad<Load extends StatusLoad>(load: Load | undefined): Load | undefined {
  if (load === undefined) return undefined;
  const { cpu, memory, disk, ...rest } = load;
  const ageMs = Number.isFinite(load.ageMs)
    ? Math.min(MAX_LOAD_AGE_MS, Math.max(0, Math.round(load.ageMs)))
    : MAX_LOAD_AGE_MS;
  return {
    ...rest,
    ageMs,
    ...(cpu !== undefined && loadCpuSchema.safeParse(cpu).success && { cpu }),
    ...(memory !== undefined && loadMemorySchema.safeParse(memory).success && { memory }),
    ...(disk !== undefined && loadDiskSchema.safeParse(disk).success && { disk }),
  } as Load;
}

export const platformCatalogSchema = z.object({
  platform: platformSchema,
  models: z.array(z.string()),
  runtimes: z.array(z.string()),
  defaultRuntime: z.string().optional(),
  modelRuntimes: z.record(z.string(), z.array(z.string())),
  modelAliases: z
    .record(
      z.string().max(CATALOG_NAME_MAX),
      z.array(z.string().max(CATALOG_NAME_MAX)).max(CATALOG_ALIASES_PER_MODEL_MAX),
    )
    .refine((aliases) => Object.keys(aliases).length <= CATALOG_ALIASED_MODELS_MAX, {
      message: `modelAliases lists more than ${CATALOG_ALIASED_MODELS_MAX} models`,
    }),
  modelClasses: z
    .record(z.string().max(CATALOG_NAME_MAX), deviceClassSchema)
    .refine((classes) => Object.keys(classes).length <= CATALOG_ALIASED_MODELS_MAX),
  classDefaults: z.partialRecord(deviceClassSchema, z.string().max(CATALOG_NAME_MAX)),
  images: z.array(catalogImageSchema).max(CATALOG_IMAGES_MAX).optional(),
  customModels: z.array(z.string().max(CATALOG_NAME_MAX)).max(CATALOG_CUSTOM_MODELS_MAX).optional(),
  /**
   * why: ADR 0005 §21: on a gateway, `models`/`runtimes` are the *union* over the fleet, and these
   * two maps say which workers each entry came from (`{"iPhone 16": ["wrk_a", "wrk_b"]}`).
   * Additive and gateway-only: a worker's own catalog needs no attribution, and a renderer
   * that predates the fleet still reads `models`/`runtimes` unchanged. Kept as annotations
   * beside the flat lists rather than as a change to their element type precisely so that
   * stays true.
   */
  modelWorkers: z.record(z.string(), z.array(z.string())).optional(),
  runtimeWorkers: z.record(z.string(), z.array(z.string())).optional(),
  slimCategories: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))
    .max(CATALOG_SLIM_CATEGORIES_MAX)
    .optional(),
  defaultMode: deviceModeSchema.optional(),
});

/**
 * why: brings a catalog entry a daemon built from its own machine within `customModels`' bounds,
 * so a custom profile name the platform's tools never checked cannot fail the whole `catalog.get`
 * answer. Lives beside the schema so the bounds are written once.
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
export const capabilityNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

const protocolRangeShapeSchema = z.object({ min: z.number().int(), max: z.number().int() });

const workerConnectionStateSchema = z.enum(["connected", "disconnected", "incompatible"]);

const MAX_LISTED_INSTALLS = 16;
const MAX_INSTALL_COMPONENT_LENGTH = 64;

/**
 * why: One component install a daemon has waiting or running. A worker's list reaches the gateway as
 * a claim (safety rule 10), so the bounds cut rather than refuse: an over-long list keeps its
 * first (oldest) 16 entries and an over-long `component` its first 64 characters, and the view
 * stays usable instead of failing its whole refresh over one field.
 */
const installInProgressSchema = z.object({
  platform: platformSchema,
  component: z.string().transform((value) => value.slice(0, MAX_INSTALL_COMPONENT_LENGTH)),
  state: z.enum(["waiting", "downloading"]),
  since: z.number(),
  waiters: z.number().int().nonnegative(),
});

function boundedInstalls<Entry extends z.ZodType>(entry: Entry) {
  return z.array(entry).transform((installs) => installs.slice(0, MAX_LISTED_INSTALLS));
}

const workerInstallsSchema = boundedInstalls(installInProgressSchema);

export const statusInstallsSchema = boundedInstalls(
  installInProgressSchema.extend({ workerId: z.string().optional() }),
);

/**
 * why: the bound above, for a producer that merges lists the schema checked one by one: a
 * gateway's fleet list must itself fit, or the schema cuts it wherever the merge left it.
 */
export const INSTALL_LIST_LIMIT = MAX_LISTED_INSTALLS;

const CAPABILITY_REASON_MAX = 500;

export const capabilitySchema = z
  .object({
    name: capabilityNameSchema,
    state: z.enum(["available", "unavailable", "off"]),
    reason: z
      .string()
      .min(1)
      .max(CAPABILITY_REASON_MAX)
      .refine((text) => !/[\p{Cc}\u2028\u2029]/u.test(text))
      .optional(),
  })
  .refine((entry) => (entry.state === "unavailable") === (entry.reason !== undefined));

export const MAX_CAPABILITIES = 16;

export const capabilityListSchema = z
  .array(capabilitySchema)
  .max(MAX_CAPABILITIES)
  .refine((list) => new Set(list.map((entry) => entry.name)).size === list.length);

export function capabilityReason(text: string): string {
  let cut = text.replace(CONTROL_CHARACTERS, " ").trim().slice(0, CAPABILITY_REASON_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut === "" ? "unknown" : cut;
}

/**
 * why: the optional fields are absent rather than zeroed on purpose -- "no capacity reported" and
 * "no capacity free" are different facts, and a console that dims one must not read the other as
 * a full machine. A `starting` worker's view has `health`, `host` and `load` only, never empty fields,
 * which would read as "nothing is leased" about a registry nobody has checked yet.
 */
export const workerViewSchema = z.object({
  capabilities: capabilityListSchema.optional(),
  load: workerLoadSchema.optional(),
  id: z.string(),
  label: z.string().optional(),
  connection: workerConnectionStateSchema,
  drained: z.boolean(),
  lastSeenAt: z.number(),
  health: daemonHealthSchema.optional(),
  version: z.string().optional(),
  protocol: z
    .object({ gateway: protocolRangeShapeSchema, worker: protocolRangeShapeSchema })
    .optional(),
  capacity: statusCapacitySchema.optional(),
  warmPool: statusWarmPoolSchema.optional(),
  downloads: z
    .object({
      policy: z.enum(["never", "on-request", "always"]),
      /** why: Optional so a gateway on an older build still parses a view. */
      timeoutMs: z.number().optional(),
    })
    .optional(),
  /** why: A worker whose own cap is lower still refuses a request the gateway accepted; this lets the gateway notice. */
  lease: z.object({ maxTtlMs: z.number() }).optional(),
  queueDepth: z.number().optional(),
  physicalQueueDepth: z.number().optional(),
  leases: z.array(leaseRecordSchema).optional(),
  devices: z.array(statusDeviceSchema).optional(),
  catalog: z.array(platformCatalogSchema).optional(),
  /** why: absent while a worker is starting, `[]` when it holds none: the worker's own `baseline.list`, read with the catalog. */
  baselines: z.array(baselineEntrySchema).max(1000).optional(),
  /** why: Cleared on connect, so a just-connected worker has none: it tells a catalog read and found empty from one not yet arrived. */
  catalogReadAt: z.number().optional(),
  host: hostFactsSchema.optional(),
  installs: workerInstallsSchema.optional(),
  waiting: z.array(waitingRequestSchema).optional(),
  update: daemonUpdateFields.update.optional(),
  lastUpdateFailure: daemonUpdateFields.lastUpdateFailure.optional(),
  latestVersion: daemonUpdateFields.latestVersion.optional(),
});

export const statusLeaseSchema = leaseRecordSchema.extend({
  workerId: z.string().optional(),
  // why: the part of a gateway lease id after `<workerId>.`, so a relayed event naming the worker's lease can be matched; set only by a gateway's `lease.list`, `lease.get` and `list.get kind=leases`.
  workerLeaseId: z.string().optional(),
});

import { z } from "zod";

import { deviceClassSchema } from "./device-schemas.js";
import { deviceModeSchema, leaseIdentitySchema } from "./schema-parts.js";
import { capabilityNameSchema } from "./status-schemas.js";

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

const capacityConfigSchema = z.discriminatedUnion("strategy", [
  fixedCapacityConfigSchema,
  resourceCapacityConfigSchema,
]);

const defaultModelsSchema = z.partialRecord(deviceClassSchema, z.array(z.string().min(1)).min(1));

const proxyAuthSchema = z.object({
  header: z.string(),
  jwksUrl: z.string(),
  issuer: z.string(),
  audience: z.string(),
  signOutUrl: z.string().optional(),
});

export const configSchema = z.object({
  mode: z.enum(["worker", "gateway"]),
  capabilities: z.record(
    capabilityNameSchema,
    z.object({ enabled: z.boolean() }).catchall(z.unknown()),
  ),
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
  update: z.object({ check: z.boolean() }),
  warmPool: z.object({
    enabled: z.boolean(),
    learn: z.boolean().optional(),
    baselineLearnAfter: z.number().optional(),
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
    maxPerRequester: z.union([
      z.number(),
      z.object({ ios: z.number().optional(), android: z.number().optional() }),
    ]),
    endWaitMs: z.number(),
  }),
  exec: z.object({ timeoutMs: z.number() }),
  diskPressure: z.object({ freeBytesThreshold: z.number() }),
  eventBuffer: z.object({ capacity: z.number() }),
  log: z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
    rotateBytes: z.number(),
  }),
  // why: Optional: a newer gateway parses this from an older worker's `config.get`.
  eventLog: z
    .object({
      retention: z.number().optional(),
      maxBytes: z.number().optional(),
    })
    .optional(),
  metrics: z.object({ retention: z.number() }).optional(),
  http: z.object({
    enabled: z.boolean(),
    host: z.string(),
    port: z.number(),
    proxyAuth: proxyAuthSchema.optional(),
  }),
  health: z.object({
    enabled: z.boolean(),
    probeIntervalMs: z.number(),
    stableObservations: z.number(),
    maxRecoveryAttempts: z.number(),
    recoveryBackoffMs: z.number(),
    maxConcurrentRecoveries: z.number(),
  }),
  // why: a platform's section also holds its driver's own keys, which no client reads: they are carried as the worker's loader validated them, the way a module's `capabilities` section is, so a new driver key changes no wire shape.
  ios: z
    .object({ defaultMode: deviceModeSchema, defaultModels: defaultModelsSchema })
    .catchall(z.unknown()),
  android: z.object({ defaultModels: defaultModelsSchema }).catchall(z.unknown()),
  gateway: z.object({
    url: z.string().optional(),
    token: z.string().optional(),
    label: z.string().optional(),
    disconnectedRetentionMs: z.number(),
    execTimeoutMs: z.number(),
    leaseRequestTimeoutMs: z.number(),
    routing: z.enum(["warm-then-free"]),
    /**
     * why: `format` and `events` are re-declared, not imported from core; a test checks `format` against core's list. `secret` is optional so a `slack` destination parses.
     */
    alerts: z.object({
      destinations: z.array(
        z.object({
          name: z.string(),
          format: z.enum(["generic", "slack"]),
          url: z.string(),
          events: z.array(z.string()),
          secret: z.string().optional(),
        }),
      ),
    }),
  }),
  stalledTransition: z.object({
    thresholdMultiplier: z.number(),
    minimumThresholdMs: z.number(),
  }),
  // why: Bounded like core's `drivers` leaves (strings, numbers and booleans only), since a gateway parses this from a worker.
  drivers: z.record(
    z.string().max(64),
    // why: The number of keys is the worker's own config.json, which its loader already validated; a gateway holds one such answer per worker, the way it holds `capabilities`.
    z.record(z.string().max(64), z.union([z.string().max(4096), z.number(), z.boolean()])),
  ),
});

/**
 * why: `TokenRole` is deliberately a different vocabulary from the session `Role` (agent/admin,
 * `roles.ts`): a `token.create --role operator` mints a credential that resolves to the admin
 * session role at `hello` (ADR 0003 §5), it is not itself that role. `worker` (ADR 0005 §8/§25)
 * is a join token that resolves to no session role at all, only an uplink, so it is a third value
 * rather than a reuse of `agent`.
 */
export const tokenRoleSchema = z.enum(["agent", "operator", "worker"]);

export const tokenRecordSchema = z.object({
  id: z.string(),
  role: tokenRoleSchema,
  label: z.string().optional(),
  createdAt: z.number(),
  // why: the uplink cuts a claimed worker id to 128 characters before the token is pinned to it.
  workerId: z.string().max(128).optional(),
});

export const daemonModeSchema = z.enum(["worker", "gateway"]);

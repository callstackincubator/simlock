import { z } from "zod";

import {
  baselineNameSchema,
  deviceClassSchema,
  grantedDeviceSchema,
  imageTagSchema,
  platformSchema,
} from "./device-schemas.js";
import { deviceModeSchema } from "./schema-parts.js";

const REQUESTER_ID_MAX = 256;
const GATEWAY_PREFIX = /^gw:[^:]{0,100}:/;

/**
 * why: 256 holds every principal Simlock builds (a sign-in-proxy `proxy:<issuer>#<sub>` reaches 255).
 * why: a gateway hands its worker `gw:<instance id>:<requester id>`, so the limit counts what
 * follows that prefix and the worker accepts the namespaced form of an id the gateway let in.
 */
export const requesterIdSchema = z
  .string()
  .refine(
    (id) => !/[\p{Cc}\u2028\u2029]/u.test(id),
    "requesterId must not contain control characters",
  )
  .refine(
    (id) => id.replace(GATEWAY_PREFIX, "").length <= REQUESTER_ID_MAX,
    `requesterId may be at most ${String(REQUESTER_ID_MAX)} characters`,
  );

/**
 * why: `ttlMs` is the width this lease was granted with, or last renewed with when a renew named
 * one -- what a body-less `lease.renew` re-applies, which is why it travels with the record
 * instead of the caller having to remember it (ADR 0004).
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
  idChosenByRequester: z.boolean(),
  worker: z.object({ id: z.string(), label: z.string().optional() }).optional(),
});

const leaseTimingSchema = z.object({
  estimatedProvisionMs: z.number(),
  estimatedBootMs: z.number(),
  estimatedReclaimMs: z.number(),
  estimatedReadyMs: z.number(),
});

const leaseEnvironmentSchema = z.record(z.string(), z.string());

export const leaseGrantSchema = z.object({
  device: grantedDeviceSchema,
  /**
   * why: Always present, `{}` at the least: containment cuts both ways, and a grant that did not
   * carry it would hand back a `driverDeviceId` no documented workflow can address.
   */
  environment: leaseEnvironmentSchema,
  lease: leaseRecordSchema,
  timing: leaseTimingSchema,
});

const requestedDeviceSchema = z.object({
  platform: platformSchema,
  model: z.string().optional(),
  class: deviceClassSchema.optional(),
  osVersion: z.string().optional(),
  mode: deviceModeSchema.optional(),
  imageTag: imageTagSchema.optional(),
  baseline: baselineNameSchema.optional(),
  physical: z.literal(true).optional(),
});

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

const waitingReasonSchema = z.enum([
  "behind-earlier-request",
  "device-limit",
  "ram-budget",
  "global-running-limit",
  "platform-running-limit",
  "waiting-for-device",
  "no-free-physical",
]);

export const capacityReasonSchema = z.enum([
  "device-limit",
  "ram-budget",
  "global-running-limit",
  "platform-running-limit",
]);

const gatewayWaitingReasonSchema = z.enum([
  "disconnected",
  "incompatible",
  "not-ready",
  "unhealthy",
  "drained",
  "updating",
  "busy",
  "no-driver",
  "unknown-model",
  "runtime-missing",
  "no-baseline",
  "baseline-mismatch",
  "baseline-stale",
  "capability-missing",
  "full",
  "no-free-physical",
  "not-chosen",
]);

const waitingRequestShape = z.object({
  id: z.string(),
  requesterId: z.string(),
  spec: requestedDeviceSchema,
  createdAt: z.number(),
  stage: z.enum(["queued", "starting"]),
  queuePosition: z.number().int().positive().optional(),
  reason: waitingReasonSchema.optional(),
  workerId: z.string().optional(),
  workers: z
    .array(
      z.object({
        workerId: z.string(),
        reason: gatewayWaitingReasonSchema,
        capacityReason: capacityReasonSchema.optional(),
      }),
    )
    .optional(),
});

/**
 * why: the request's idempotency key and owner are never part of it: a key lets its holder
 * replay the request, and neither is the operator's.
 */
export const waitingRequestSchema = Object.assign(
  waitingRequestShape
    .refine((request) => request.reason === undefined || request.stage === "queued", {
      message: "a starting request has no reason",
      path: ["reason"],
    })
    .refine(
      (request) =>
        (request.workers ?? []).every(
          (entry) => entry.capacityReason === undefined || entry.reason === "full",
        ),
      { message: "a capacity reason belongs to full", path: ["workers"] },
    )
    .refine(
      (request) =>
        new Set((request.workers ?? []).map((entry) => entry.workerId)).size ===
        (request.workers ?? []).length,
      { message: "a worker is listed once", path: ["workers"] },
    ),
  // why: the refinement hides the object's `shape`, which a reader of the field list still needs.
  { shape: waitingRequestShape.shape },
);

/**
 * why: the command `simlock simctl` / `simlock adb` runs is spawned as-is, so the shape is
 * validated at the boundary like every other output: an argument list that is not entirely
 * strings would otherwise stringify into whatever the tool made of it.
 */
export const passthroughCommandSchema = z.object({
  args: z.array(z.string()),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()),
});

export const leaseProgressSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("queued"), queuePosition: z.number() }),
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

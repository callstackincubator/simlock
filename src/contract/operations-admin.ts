import { z } from "zod";
import {
  EVENTS_PAGE_MAX,
  EVENTS_PAGE_WITH_SINCE_MESSAGE,
  EVENTS_WORKER_MAX,
  eventsPageWithoutSince,
} from "./events-page.js";
import { defineOperation, type Effect } from "./operation-definition.js";
import { type OperationRole, type Role } from "./roles.js";
import {
  baselineEntrySchema,
  baselineNameSchema,
  baselineNoteSchema,
  cleanupRuleSummarySchema,
  configSchema,
  daemonHealthSchema,
  daemonUpdateFields,
  deviceRecordSchema,
  doctorReportSchema,
  EVENT_ID_PATTERN,
  eventEnvelopeSchema,
  imageTagSchema,
  nukeReportSchema,
  platformSchema,
  proposalSchema,
  statusDeviceSchema,
  statusLeaseSchema,
  tokenRecordSchema,
  tokenRoleSchema,
  updateRequestedVersionSchema,
  usageOutputSchema,
  usageWindowSchema,
  waitingRequestSchema,
  WARM_POOL_LEARNED_KINDS_MAX,
  WARM_POOL_NAME_MAX,
} from "./schemas.js";

const doctorRunInputSchema = z.object({
  fix: z.boolean().optional(),
  /**
   * why: Destroys every orphan the run finds (ADR 0001, decision 5) -- the single opt-in exception
   * to registry-only destruction (safety rule 1). Its own flag rather than part of `fix`, so a
   * `doctor --fix` already running unattended in CI does not acquire a destructive behaviour on
   * upgrade.
   */
  purgeOrphans: z.boolean().optional(),
});

export const doctorRun = defineOperation({
  name: "doctor.run",
  /**
   * why: The role genuinely depends on the input: `fix: false` (read-only, shells out per device)
   * is agent-visible; `fix: true` (applies safe fixes to registry-owned devices) is admin
   * only -- see ADR §3's matrix, which lists `doctor.run` twice for exactly this reason. A
   * function-of-input role, rather than an `authorize` hook, is the right tool here: `authorize`
   * (ADR §1's `ownsLease` example) is for *ownership* checks against a specific resource once a
   * role has already cleared the gate; this is a *role* decision, and it is entirely computable
   * from the already-validated input with no session/resource context needed. Keeping it as
   * `role` also means the dispatcher's role-check step (PR 2) stays uniform -- "compute the
   * required role from the input, compare to the session role" -- for every operation, instead
   * of `doctor.run` needing a second, bespoke gating path.
   */
  role: (input: z.infer<typeof doctorRunInputSchema>): Role =>
    input.fix || input.purgeOrphans ? "admin" : "agent",
  effect: (input: z.infer<typeof doctorRunInputSchema>): Effect =>
    input.fix || input.purgeOrphans ? "write" : "read",
  input: doctorRunInputSchema,
  output: doctorReportSchema,
});

/** Arm order is load-bearing: a full record matches the first arm, so a worker's answer is unchanged. */
export const listGet = defineOperation({
  name: "list.get",
  role: "viewer",
  effect: "read",
  input: z.object({ kind: z.enum(["devices", "leases", "rules", "requests"]).optional() }),
  output: z.union([
    z.array(deviceRecordSchema),
    z.array(statusDeviceSchema),
    z.array(statusLeaseSchema),
    z.array(cleanupRuleSummarySchema),
    z.array(waitingRequestSchema),
  ]),
});

export const cleanupRun = defineOperation({
  name: "cleanup.run",
  role: "admin",
  effect: (input: { dryRun?: boolean | undefined }): Effect => (input.dryRun ? "read" : "write"),
  input: z.object({ dryRun: z.boolean().optional(), rule: z.string().optional() }),
  output: z.array(proposalSchema),
});

export const nukeRun = defineOperation({
  name: "nuke.run",
  role: "admin",
  effect: "write",
  input: z.object({ deleteDevices: z.boolean().optional() }),
  output: nukeReportSchema,
});

const warmKindSchema = z.object({
  platform: platformSchema,
  model: z.string().max(WARM_POOL_NAME_MAX),
  osVersion: z.string().max(WARM_POOL_NAME_MAX),
  mode: z.enum(["slim", "full"]),
  imageTag: imageTagSchema.optional(),
  baseline: baselineNameSchema.optional(),
});

export const warmForget = defineOperation({
  name: "warm.forget",
  role: "admin",
  effect: "write",
  input: z.object({
    platform: platformSchema,
    model: z.string().min(1).max(WARM_POOL_NAME_MAX),
    osVersion: z.string().min(1).max(WARM_POOL_NAME_MAX).optional(),
    mode: z.enum(["slim", "full"]).optional(),
    imageTag: imageTagSchema.optional(),
  }),
  output: z.object({ forgotten: z.array(warmKindSchema).max(WARM_POOL_LEARNED_KINDS_MAX) }),
});

export const baselineSave = defineOperation({
  name: "baseline.save",
  role: "admin",
  effect: "write",
  input: z
    .object({
      leaseId: z.string().min(1).max(256),
      name: baselineNameSchema,
      note: baselineNoteSchema.optional(),
    })
    .strict(),
  output: z.object({ baseline: baselineEntrySchema, leaseId: z.string().max(256) }),
});

export const baselineList = defineOperation({
  name: "baseline.list",
  role: "any",
  effect: "read",
  input: z.object({}).strict(),
  output: z.object({ baselines: z.array(baselineEntrySchema).max(1000) }),
});

export const baselineRemove = defineOperation({
  name: "baseline.remove",
  role: "admin",
  effect: "write",
  // why: `workerId` names the worker a gateway forwards the remove to; a gateway requires it and strips it, a worker refuses it.
  input: z
    .object({
      name: baselineNameSchema,
      workerId: z.string().min(1).max(EVENTS_WORKER_MAX).optional(),
    })
    .strict(),
  output: z.object({
    name: baselineNameSchema,
    versions: z.array(z.number().int().min(1)).max(1000),
    deletedDevices: z.array(z.string().max(256)).max(1000),
  }),
});

export const configGet = defineOperation({
  name: "config.get",
  // why: redacted config is safe for read-only console views, while unredacted secrets stay admin-only.
  role: (input: { showSecrets?: boolean | undefined }): OperationRole =>
    input.showSecrets ? "admin" : "viewer",
  effect: "read",
  input: z.object({ showSecrets: z.boolean().optional() }),
  output: configSchema,
});

export const daemonStop = defineOperation({
  name: "daemon.stop",
  role: "admin",
  effect: "write",
  input: z.object({}),
  output: z.object({ stopping: z.literal(true) }),
});

// why: `DaemonServer` dispatches it on a connection whose protocol range does not overlap (like `daemon.stop`), so its input and answer never change shape.
export const daemonUpdate = defineOperation({
  name: "daemon.update",
  role: "admin",
  effect: "write",
  input: z
    .object({
      version: updateRequestedVersionSchema.optional(),
      force: z.boolean().optional(),
      query: z.boolean().optional(),
    })
    .refine(
      (input) => input.query !== true || (input.version === undefined && input.force === undefined),
      {
        message: "query takes no other field",
      },
    ),
  output: z.object({
    started: z.boolean(),
    upToDate: z.boolean(),
    resolved: updateRequestedVersionSchema.nullable(),
    version: daemonUpdateFields.version,
    health: daemonHealthSchema,
    update: daemonUpdateFields.update,
    lastUpdateFailure: daemonUpdateFields.lastUpdateFailure,
    latestVersion: daemonUpdateFields.latestVersion,
  }),
});

export const eventsReplay = defineOperation({
  name: "events.replay",
  role: "viewer",
  effect: "read",
  input: z
    .object({
      beforeId: z.string().regex(EVENT_ID_PATTERN).optional(),
      limit: z.number().int().min(1).max(EVENTS_PAGE_MAX).optional(),
      sinceTs: z.number().optional(),
      workerId: z.string().min(1).max(EVENTS_WORKER_MAX).optional(),
    })
    .refine(eventsPageWithoutSince, { message: EVENTS_PAGE_WITH_SINCE_MESSAGE }),
  output: z.array(eventEnvelopeSchema),
});

export const usageGet = defineOperation({
  name: "usage.get",
  role: "viewer",
  effect: "read",
  input: usageWindowSchema,
  output: usageOutputSchema,
});

export const eventsSubscribe = defineOperation({
  name: "events.subscribe",
  role: "viewer",
  effect: "read",
  input: z.object({}),
  output: z.object({ subscribed: z.literal(true), subscriptionId: z.string() }),
});

export const eventsUnsubscribe = defineOperation({
  name: "events.unsubscribe",
  role: "viewer",
  effect: "read",
  input: z.object({}),
  output: z.object({ subscribed: z.literal(false) }),
});

// why: ADR §11 makes the daemon the only owner of the tokens, and that move has landed: both
// dispatchers handle these three, the CLI reaches them as admin round-trips from
// `src/cli/commands/token.ts`, and no CLI code reads the token store itself. The declarations live
// here because the `OPERATIONS` map every dispatcher validates against is built from this file.

export const tokenCreate = defineOperation({
  name: "token.create",
  role: "admin",
  effect: "write",
  input: z.object({ role: tokenRoleSchema, label: z.string().optional() }),
  output: z.object({ secret: z.string(), token: tokenRecordSchema }),
});

export const tokenList = defineOperation({
  name: "token.list",
  role: "viewer",
  effect: "read",
  input: z.object({}),
  output: z.object({ tokens: z.array(tokenRecordSchema) }),
});

export const tokenRevoke = defineOperation({
  name: "token.revoke",
  role: "admin",
  effect: "write",
  input: z.object({ id: z.string() }),
  output: z.object({ revoked: z.boolean() }),
});

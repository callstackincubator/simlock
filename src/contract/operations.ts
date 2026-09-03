/**
 * Every daemon operation, declared once (ADR 0003 §1). Name, role, input schema, output
 * schema, optional `authorize` hook. Public TypeScript types are inferred from the zod
 * schemas, never hand-written in parallel -- see each operation's `Input`/`Output` export.
 *
 * `defineOperation` returning a typed record whose `role` may be a plain `Role` or a function
 * of the (already-validated) input is what lets `doctor.run` model an input-dependent role
 * honestly (see its declaration below) without a second gating mechanism next to `authorize`.
 */
import { z } from "zod";

import { ownsLease, type AuthorizeContext, type Role } from "./roles.js";
import {
  cleanupRuleSummarySchema,
  configSchema,
  daemonHealthSchema,
  deviceRecordSchema,
  doctorReportSchema,
  eventEnvelopeSchema,
  leaseGrantSchema,
  leaseModeSchema,
  leaseRecordSchema,
  nukeReportSchema,
  platformCatalogSchema,
  platformSchema,
  proposalSchema,
  statusCapacitySchema,
  tokenRecordSchema,
  tokenRoleSchema,
} from "./schemas.js";

export interface OperationDefinition<
  Name extends string = string,
  InputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly name: Name;
  readonly role: Role | ((input: z.infer<InputSchema>) => Role);
  readonly input: InputSchema;
  readonly output: OutputSchema;
  /** Ownership/ownership-adjacent gating a session-aware dispatcher would run after the role
   * check (ADR §1's `ownsLease` example). Declared for typing purposes only in this PR --
   * nothing sets it, and nothing calls it; PR 2 adds both. */
  readonly authorize?: (input: z.infer<InputSchema>, context: AuthorizeContext) => boolean;
}

export function defineOperation<
  Name extends string,
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny,
>(
  definition: OperationDefinition<Name, InputSchema, OutputSchema>,
): OperationDefinition<Name, InputSchema, OutputSchema> {
  return definition;
}

// ---- catalog.get ------------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const catalogGet = defineOperation({
  name: "catalog.get",
  role: "agent",
  input: z.object({ platform: platformSchema.optional() }),
  output: z.object({ platforms: z.array(platformCatalogSchema) }),
});

// ---- status.get ---------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const statusGet = defineOperation({
  name: "status.get",
  role: "agent",
  input: z.object({}),
  output: z.object({
    devices: z.array(deviceRecordSchema),
    leases: z.array(leaseRecordSchema),
    capacity: statusCapacitySchema,
    health: daemonHealthSchema,
    queueDepth: z.number(),
  }),
});

// ---- lease.request --------------------------------------------------------------------------

/**
 * No `device`/`os` legacy aliases and no nested `request` wrapper -- both accepted by today's
 * daemon (`server.ts:559-565`), neither carried forward. The wire moves to protocol 3 with no
 * compatibility shim (ADR "Consequences"); this is a deliberate break, called out in the PR
 * description. `.strict()` on top of dropping the fields: an old client sending `device`/`os`/
 * `request` now gets a clear `BAD_REQUEST` instead of those keys silently vanishing.
 */
const leaseRequestInputSchema = z
  .object({
    model: z.string().min(1),
    platform: platformSchema,
    osVersion: z.string().optional(),
    full: z.boolean().optional(),
    mode: leaseModeSchema.optional(),
    requesterId: z.string().optional(),
    allowDownload: z.boolean().optional(),
    noWait: z.boolean().optional(),
    timeoutMs: z.number().finite().positive().optional(),
    /** ADR §9: initial TTL for a detached lease. Supplying it for a held lease is
     * `BAD_REQUEST` -- held TTL is the backstop, not the caller's to shorten -- enforced below
     * via `superRefine` rather than left to the handler, so the rule is part of the contract
     * itself. Wired through to `LeaseRequestOptions.ttlMs` (src/core/wait-queue.ts) by the
     * dispatcher's `lease.request` handler. */
    ttlMs: z.number().finite().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ttlMs !== undefined && (value.mode ?? "held") === "held") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "ttlMs is BAD_REQUEST for a held lease: held TTL is the backstop, not the caller's to shorten",
        path: ["ttlMs"],
      });
    }
  });

export const leaseRequest = defineOperation({
  name: "lease.request",
  role: "agent",
  input: leaseRequestInputSchema,
  output: leaseGrantSchema,
});

// ---- lease.cancel (new, ADR §9) --------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseCancel = defineOperation({
  name: "lease.cancel",
  role: "agent",
  input: z.object({ requesterId: z.string().optional() }),
  output: z.object({ result: z.enum(["cancelled", "not-found", "not-cancellable"]) }),
});

// ---- lease.renew ----------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseRenew = defineOperation({
  name: "lease.renew",
  role: "agent",
  input: z.object({ leaseId: z.string(), ttlMs: z.number().finite().positive().optional() }),
  output: leaseRecordSchema,
  authorize: ownsLease((input) => input.leaseId),
});

// ---- lease.release --------------------------------------------------------------------------

export const leaseRelease = defineOperation({
  name: "lease.release",
  role: "agent",
  input: z.object({ leaseId: z.string() }),
  output: z.object({ leaseId: z.string() }),
  authorize: ownsLease((input) => input.leaseId),
});

// ---- lease.list (new, ADR §9) -----------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseList = defineOperation({
  name: "lease.list",
  role: "agent",
  input: z.object({}),
  output: z.object({ leases: z.array(leaseRecordSchema) }),
});

// ---- lease.heartbeat ------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseHeartbeat = defineOperation({
  name: "lease.heartbeat",
  role: "agent",
  input: z.object({}),
  output: z.object({
    leases: z.array(z.object({ leaseId: z.string(), ttlDeadline: z.number() })),
  }),
});

// ---- doctor.run -------------------------------------------------------------------------------

const doctorRunInputSchema = z.object({ fix: z.boolean().optional() });

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const doctorRun = defineOperation({
  name: "doctor.run",
  /**
   * The role genuinely depends on the input: `fix: false` (read-only, shells out per device)
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
  role: (input: z.infer<typeof doctorRunInputSchema>): Role => (input.fix ? "admin" : "agent"),
  input: doctorRunInputSchema,
  output: doctorReportSchema,
});

// ---- lease.release-all ------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseReleaseAll = defineOperation({
  name: "lease.release-all",
  role: "admin",
  input: z.object({}),
  output: z.object({ leaseIds: z.array(z.string()) }),
});

// ---- list.get -----------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const listGet = defineOperation({
  name: "list.get",
  role: "admin",
  input: z.object({ kind: z.enum(["devices", "leases", "rules"]).optional() }),
  output: z.union([
    z.array(deviceRecordSchema),
    z.array(leaseRecordSchema),
    z.array(cleanupRuleSummarySchema),
  ]),
});

// ---- cleanup.run --------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const cleanupRun = defineOperation({
  name: "cleanup.run",
  role: "admin",
  input: z.object({ dryRun: z.boolean().optional(), rule: z.string().optional() }),
  output: z.array(proposalSchema),
});

// ---- nuke.run -----------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const nukeRun = defineOperation({
  name: "nuke.run",
  role: "admin",
  input: z.object({ deleteDevices: z.boolean().optional() }),
  output: nukeReportSchema,
});

// ---- config.get ---------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const configGet = defineOperation({
  name: "config.get",
  role: "admin",
  input: z.object({}),
  output: configSchema,
});

// ---- daemon.stop --------------------------------------------------------------------------
//
// Part of the closed OPERATIONS registry (ADR §3); `daemon.stop` is handled as a
// frozen-exception special case in `DaemonServer#dispatchLine` rather than through the normal
// dispatch switch, so nothing imports this declaration by name yet. Declared here because the
// contract must still describe its input/output/role.

// fallow-ignore-next-line unused-export -- see the comment above.
export const daemonStop = defineOperation({
  name: "daemon.stop",
  role: "admin",
  input: z.object({}),
  output: z.object({ stopping: z.literal(true) }),
});

// ---- events.replay ------------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const eventsReplay = defineOperation({
  name: "events.replay",
  role: "admin",
  input: z.object({ sinceTs: z.number().optional() }),
  output: z.array(eventEnvelopeSchema),
});

// ---- events.subscribe ---------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const eventsSubscribe = defineOperation({
  name: "events.subscribe",
  role: "admin",
  input: z.object({}),
  output: z.object({ subscribed: z.literal(true), subscriptionId: z.string() }),
});

// ---- events.unsubscribe -------------------------------------------------------------------

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const eventsUnsubscribe = defineOperation({
  name: "events.unsubscribe",
  role: "admin",
  input: z.object({}),
  output: z.object({ subscribed: z.literal(false) }),
});

// ---- token.create / token.list / token.revoke --------------------------------------------
//
// ADR §11: "token create|list|revoke become daemon operations. The daemon is the only owner of
// tokens.json." No daemon-side handler exists for these yet -- today `TokenStore` is read and
// written directly by the CLI (`src/cli/index.ts`, `src/http/token-store.ts`). Declaring the
// operation here, with no matching case in `DaemonServer#handleRequest`, is expected and fine
// per this PR's brief ("declaring an operation whose handler does not exist yet"); moving the
// CLI onto a daemon round-trip for these is later work (PR 4, per the ADR's sequencing).

// fallow-ignore-next-line unused-export -- see the block comment above; declared now per this PR's brief.
export const tokenCreate = defineOperation({
  name: "token.create",
  role: "admin",
  input: z.object({ role: tokenRoleSchema, label: z.string().optional() }),
  output: z.object({ secret: z.string(), token: tokenRecordSchema }),
});

// fallow-ignore-next-line unused-export -- same as tokenCreate above.
export const tokenList = defineOperation({
  name: "token.list",
  role: "admin",
  input: z.object({}),
  output: z.object({ tokens: z.array(tokenRecordSchema) }),
});

// fallow-ignore-next-line unused-export -- same as tokenCreate above.
export const tokenRevoke = defineOperation({
  name: "token.revoke",
  role: "admin",
  input: z.object({ id: z.string() }),
  output: z.object({ revoked: z.boolean() }),
});

// ---- the full registry ----------------------------------------------------------------------

export const OPERATIONS = {
  "catalog.get": catalogGet,
  "status.get": statusGet,
  "lease.request": leaseRequest,
  "lease.cancel": leaseCancel,
  "lease.renew": leaseRenew,
  "lease.release": leaseRelease,
  "lease.list": leaseList,
  "lease.heartbeat": leaseHeartbeat,
  "doctor.run": doctorRun,
  "lease.release-all": leaseReleaseAll,
  "list.get": listGet,
  "cleanup.run": cleanupRun,
  "nuke.run": nukeRun,
  "config.get": configGet,
  "daemon.stop": daemonStop,
  "events.replay": eventsReplay,
  "events.subscribe": eventsSubscribe,
  "events.unsubscribe": eventsUnsubscribe,
  "token.create": tokenCreate,
  "token.list": tokenList,
  "token.revoke": tokenRevoke,
} as const;

export type OperationName = keyof typeof OPERATIONS;

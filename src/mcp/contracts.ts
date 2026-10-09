/**
 * MCP tool schemas, derived from the contract's operation schemas (ADR 0003 §11: "MCP tool
 * schemas are derived from the contract schemas. Tool names stay."). Nothing here hand-declares
 * a field the contract already declares -- each schema below is the contract's own zod object
 * for that operation, or a small `.omit()`/`.extend()`/`.partial()` composition of it. A
 * contract schema change is a compile-time (or, for a structurally-compatible-but-different
 * shape, a test) change here too, not a silent drift.
 *
 * Field names follow the contract's own vocabulary (camelCase: `leaseId`, `deviceId`,
 * `allowDownload`, ...), not the snake_case this module used before PR 4. This is a deliberate
 * break (0.x, ADR "Alternatives considered": "one vocabulary everywhere is the point") -- see
 * the PR report for the tradeoffs.
 */
import { z } from "zod";

import {
  leaseRecordSchema,
  leaseRequestFields,
  OPERATIONS,
  refuseModelWithClass,
} from "../contract/index.js";

// ---- lease_simulator ---------------------------------------------------------------------

/**
 * `lease.request`'s input, minus the two fields this tool never lets the caller set:
 * `requesterId` (session-controlled -- see `main.ts`'s requester resolution, never
 * caller-supplied, for the same reason the daemon never lets a request rename its own
 * principal) and `fleetRequestId` (a gateway's own mark on its dispatch to a worker, ADR 0021).
 * `ttlMs` is no longer omitted: ADR 0004 accepts it on every request, so this tool
 * inherits it from the contract like every other field -- `lease.defaultTtlMs` when the caller
 * names none, `BAD_REQUEST` above `lease.maxTtlMs`. `mode` is the device mode, inherited the
 * same way: `slim` or `full`, absent for the worker's default, anything else `BAD_REQUEST`.
 * `imageTag` is inherited too, bounded by the contract. `model` and `class` are both optional and
 * refused together (ADR 0015 §1) by the contract's own refinement when the request reaches
 * `lease.request`, not here: a refined schema has no `.shape`, so the SDK would list the tool with
 * no fields at all. A malformed `osVersion` is refused the same way, by the contract's own check
 * when the request reaches `lease.request`: the MCP side adds no second check.
 */
export const leaseSimulatorInputSchema = leaseRequestFields.omit({
  fleetRequestId: true,
  requesterId: true,
});

/**
 * The tool's input with the contract's model-or-class check on top, for the handler to run
 * before asking: the SDK lists and validates the plain object above, which is all it can read.
 */
export const leaseSimulatorCheckedInputSchema =
  leaseSimulatorInputSchema.superRefine(refuseModelWithClass());

/** `lease.request`'s output verbatim -- the device/lease/timing grant. */
export const leaseSimulatorOutputSchema = OPERATIONS["lease.request"].output;

// ---- list_devices -------------------------------------------------------------------------

export const listDevicesInputSchema = OPERATIONS["catalog.get"].input;
export const listDevicesOutputSchema = OPERATIONS["catalog.get"].output;

// ---- release_simulator ---------------------------------------------------------------------

export const releaseSimulatorInputSchema = OPERATIONS["lease.release"].input;
/** `lease.release`'s output (`{leaseId}`) plus a friendly `released: true` literal -- an
 * addition on top of the contract shape, not a hand duplicate of it. */
export const releaseSimulatorOutputSchema = OPERATIONS["lease.release"].output.extend({
  released: z.literal(true),
});

// ---- lease_status -------------------------------------------------------------------------

/** `lease_status` is one `lease.list` call (ADR §9), not a session-local cache read. */
export const leaseStatusInputSchema = OPERATIONS["lease.list"].input;

/**
 * `lease.list` returns `{leases: LeaseRecord[]}`, filtered by the daemon to the owner
 * principal only -- it can include leases this session never requested (see
 * `McpSession#status`'s doc comment). `session.ts` narrows that array down to at most one
 * entry -- the lease this session's own `lease()` call obtained, if any -- before this schema
 * flattens it onto a `held` discriminant. `held` is this tool's own word for "the lease this
 * session is renewing", not a daemon-side lease mode; there is only one kind of lease (ADR
 * 0004). Flat and all-optional -- not a discriminated union -- because the MCP SDK validates
 * `structuredContent` against `outputSchema` as a plain object shape.
 */
export const leaseStatusOutputSchema = leaseRecordSchema.partial().extend({ held: z.boolean() });

export type LeaseSimulatorInput = z.infer<typeof leaseSimulatorInputSchema>;
export type LeaseSimulatorOutput = z.infer<typeof leaseSimulatorOutputSchema>;
export type ListDevicesInput = z.infer<typeof listDevicesInputSchema>;
export type ListDevicesOutput = z.infer<typeof listDevicesOutputSchema>;
export type ReleaseSimulatorInput = z.infer<typeof releaseSimulatorInputSchema>;
export type ReleaseSimulatorOutput = z.infer<typeof releaseSimulatorOutputSchema>;
export type LeaseStatusOutput = z.infer<typeof leaseStatusOutputSchema>;

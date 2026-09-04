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

import { leaseRecordSchema, OPERATIONS } from "../contract/index.js";

// ---- lease_simulator ---------------------------------------------------------------------

/**
 * `lease.request`'s input, minus the three fields this tool never lets the caller set:
 * `requesterId` (session-controlled -- see `session.ts`'s `#requesterId`, never caller-supplied,
 * for the same reason the daemon never lets a request rename its own principal), `mode` (this
 * tool always leases `"held"`), and `ttlMs` (only meaningful for a detached lease, which this
 * tool never requests -- and is `BAD_REQUEST` for a held one per the contract's own
 * `superRefine`). `.innerType()` unwraps the contract schema's `superRefine` wrapper down to
 * the plain (still `.strict()`) object so `.omit()` is available -- see zod's `ZodEffects`.
 */
export const leaseSimulatorInputSchema = OPERATIONS["lease.request"].input
  .innerType()
  .omit({ mode: true, requesterId: true, ttlMs: true });

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
 * `lease.list` returns `{leases: LeaseRecord[]}`; this session ever holds at most one lease (one
 * requester id, always `mode: "held"`), so the tool flattens that array's first entry (or none)
 * onto a `held` discriminant. Flat and all-optional -- not a discriminated union -- because the
 * MCP SDK validates `structuredContent` against `outputSchema` as a plain object shape.
 */
export const leaseStatusOutputSchema = leaseRecordSchema.partial().extend({ held: z.boolean() });

export type LeaseSimulatorInput = z.infer<typeof leaseSimulatorInputSchema>;
export type LeaseSimulatorOutput = z.infer<typeof leaseSimulatorOutputSchema>;
export type ListDevicesInput = z.infer<typeof listDevicesInputSchema>;
export type ListDevicesOutput = z.infer<typeof listDevicesOutputSchema>;
export type ReleaseSimulatorInput = z.infer<typeof releaseSimulatorInputSchema>;
export type ReleaseSimulatorOutput = z.infer<typeof releaseSimulatorOutputSchema>;
export type LeaseStatusOutput = z.infer<typeof leaseStatusOutputSchema>;

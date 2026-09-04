/**
 * Server pushes (ADR 0003 §8). Three families, each with its correlation key required by
 * schema:
 *
 * - Request-scoped (`progress`): carries the originating request's frame id.
 * - Lease-scoped (`lease-lost`, `device-unhealthy`, `device-recovered`): carries the lease id.
 * - Connection-scoped (`lease.heartbeat`, `event` -- `event` carries a subscription id).
 *
 * Today's `progress` push carries no correlation id at all (see the daemon inventory); adding
 * one to the schema is this PR's job. Actually routing a push to "every live connection whose
 * principal owns the lease" (§8) is not -- that needs the `ownerId`/principal work in PR 2. The
 * schemas here describe the target shape; `src/daemon/server.ts` is updated in this PR to
 * populate the two ids that don't need ownership at all (`progress`'s request id, `event`'s
 * subscription id) but still routes lease-scoped pushes the old way (single
 * `heldLeaseIds`-membership lookup) until PR 2.
 */
import { z } from "zod";

import { eventEnvelopeSchema, leaseProgressSchema } from "./schemas.js";

/**
 * Per-kind schemas are intentionally not exported individually -- `PUSH_SCHEMAS` (below) is the
 * one public surface for these, keyed by wire push kind, which is how `DaemonServer` actually
 * consumes them (`this.#parseOutput(PUSH_SCHEMAS.progress, ...)`). Frame ids are `string |
 * number` on the wire (see `daemon-protocol`'s `RequestId`).
 */
const requestIdSchema = z.union([z.string(), z.number()]);

const progressPushSchema = z.object({
  requestId: requestIdSchema,
  progress: leaseProgressSchema,
});

const leaseLostPushSchema = z.object({
  leaseId: z.string(),
  deviceId: z.string(),
  reason: z.string(),
});

const deviceUnhealthyPushSchema = z.object({
  leaseId: z.string(),
  deviceId: z.string(),
  reason: z.literal("crashed"),
});

const deviceRecoveredPushSchema = z.object({
  leaseId: z.string(),
  deviceId: z.string(),
  attempts: z.number(),
});

const heartbeatPushSchema = z.object({ nonce: z.number() });

const eventPushSchema = z.object({
  subscriptionId: z.string(),
  event: eventEnvelopeSchema,
});

export const PUSH_SCHEMAS = {
  progress: progressPushSchema,
  "lease-lost": leaseLostPushSchema,
  "device-unhealthy": deviceUnhealthyPushSchema,
  "device-recovered": deviceRecoveredPushSchema,
  "lease.heartbeat": heartbeatPushSchema,
  event: eventPushSchema,
} as const;

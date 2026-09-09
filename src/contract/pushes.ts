/**
 * Server pushes (ADR 0003 §8). Three families, each with its correlation key required by
 * schema:
 *
 * - Request-scoped (`progress`, `output`): carries the originating request's frame id.
 * - Lease-scoped (`lease-lost`, `device-unhealthy`, `device-recovered`): carries the lease id,
 *   and goes to every live connection whose principal owns that lease (ADR 0004 §5 keeps
 *   these; they are facts about the device, not a liveness channel).
 * - Connection-scoped (`event`, which carries a subscription id).
 *
 * ADR 0004 removes the fourth kind: `lease.heartbeat` was a daemon-initiated liveness push,
 * and nothing replaces it -- a client-initiated `lease.renew` is the whole mechanism now.
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

/**
 * ADR 0005 §19a: one chunk of a running `device.exec` command's output, keyed by the
 * originating request's frame id exactly as `progress` is, so a connection with more than one
 * command in flight routes each chunk to its own call.
 *
 * `chunk` is text, not a line and not a frame: it is whatever the child wrote, decoded as
 * UTF-8, forwarded the moment it arrives. Nothing joins, splits, or buffers it -- ADR §19e
 * says output is streamed and never buffered, so there is no size cap and no last-line
 * flush to wait for. A consumer that wants lines splits them itself; a consumer that wants
 * bytes should know this is a lossy edge for binary output (a `simctl io ... screenshot`
 * writes its PNG to a path on the worker, not to stdout), which is why the field is a string
 * rather than base64 with an `encoding` discriminator: the common case stays free of a
 * decode step, and the uncommon one is not what this operation is for.
 */
const outputPushSchema = z.object({
  requestId: requestIdSchema,
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(),
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

const eventPushSchema = z.object({
  subscriptionId: z.string(),
  event: eventEnvelopeSchema,
});

export const PUSH_SCHEMAS = {
  progress: progressPushSchema,
  output: outputPushSchema,
  "lease-lost": leaseLostPushSchema,
  "device-unhealthy": deviceUnhealthyPushSchema,
  "device-recovered": deviceRecoveredPushSchema,
  event: eventPushSchema,
} as const;

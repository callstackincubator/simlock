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

/**
 * ADR 0005 §19a: a forwarded `device.exec`'s process now exists on the worker, keyed by the
 * originating request's frame id exactly as `output` is.
 *
 * This is the fact a transport needs to choose its response shape on, and it is the one fact a
 * gateway cannot infer. The worker already knows the moment -- its dispatcher spawns the child
 * and then calls `DispatchSession.onStarted`, after every failure that can happen before a
 * process exists (a refused verb, an unknown tool, an unowned lease, a daemon still starting)
 * and before any output. Directly against a worker that signal reaches the transport; across an
 * uplink it used to stop at the worker's edge, so the gateway guessed with a timer -- and a
 * refusal that arrived after the timer got a `200` with the error buried in the stream, where
 * §19a requires a `422`. Sending the fact removes the guess.
 *
 * Additive: a peer that never sends it leaves a gateway on its previous behaviour, so the
 * protocol range does not move (ADR 0003 §6).
 */
const startedPushSchema = z.object({
  requestId: requestIdSchema,
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
  started: startedPushSchema,
  "lease-lost": leaseLostPushSchema,
  "device-unhealthy": deviceUnhealthyPushSchema,
  "device-recovered": deviceRecoveredPushSchema,
  event: eventPushSchema,
} as const;

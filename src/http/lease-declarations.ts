import { z } from "@hono/zod-openapi";

import { declareRoute, firstValue, sseMessage } from "./routes.js";

const leaseParamsSchema = z.object({ id: z.string() });

const leasePayloadSchema = z.object({
  createdAt: z.string(),
  dataPlane: z.null(),
  device: z.string(),
  deviceId: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  imageTag: z.string().optional(),
  mode: z.enum(["slim", "full"]).optional(),
  os: z.string(),
  platform: z.string(),
  requestId: z.string().optional(),
  ttlMs: z.number(),
  udid: z.string(),
  worker: z.object({ id: z.string(), label: z.string().optional() }).optional(),
  workerId: z.string().optional(),
});

const requestErrorSchema = z.object({ code: z.string(), message: z.string() });

const requestBaseShape = { createdAt: z.string(), id: z.string() };

export const leaseRequestViewSchema = z.discriminatedUnion("state", [
  z.object({ ...requestBaseShape, queuePosition: z.number(), state: z.literal("queued") }),
  z.object({
    ...requestBaseShape,
    component: z.string(),
    percent: z.number().optional(),
    state: z.literal("downloading"),
    waiting: z.boolean(),
  }),
  z.object({
    ...requestBaseShape,
    etaSeconds: z.number(),
    state: z.enum(["reclaiming", "provisioning", "booting"]),
  }),
  z.object({ ...requestBaseShape, lease: leasePayloadSchema, state: z.literal("granted") }),
  z.object({ ...requestBaseShape, error: requestErrorSchema, state: z.literal("failed") }),
  z.object({ ...requestBaseShape, state: z.literal("cancelled") }),
]);

const leaseRequestReplySchema = z.object({ request: leaseRequestViewSchema });

const waitQuerySchema = z
  .object({
    wait: firstValue(z.string())
      .optional()
      .openapi({ description: "Seconds to wait for the request to change; at most 60." }),
  })
  .superRefine((query, context) => {
    if (query.wait === undefined) return;
    const seconds = Number(query.wait);
    if (!Number.isFinite(seconds) || seconds < 0) {
      context.addIssue({
        code: "custom",
        message: "wait must be a non-negative number of seconds",
        path: [],
      });
    }
  });

const leaseNoticeSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("device_unhealthy") }),
  z.object({ attempts: z.number(), event: z.literal("device_recovered") }),
  z.object({ event: z.literal("lease_lost"), reason: z.string() }),
]);

// why: `ttlMs` is read as unknown so that each way it can be wrong keeps its own whole-body message.
export const renewBodySchema = z
  .object(
    {
      ttlMs: z
        .unknown()
        .optional()
        .openapi({ description: "The new width of the lease, in ms.", type: "number" }),
    },
    { error: "Body must be a JSON object" },
  )
  .superRefine((body, context) => {
    if (body.ttlMs === undefined) return;
    if (typeof body.ttlMs !== "number") {
      context.addIssue({ code: "custom", message: "ttlMs must be a number", path: [] });
    } else if (!Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
      context.addIssue({ code: "custom", message: "ttlMs must be a positive number", path: [] });
    }
  })
  .transform((body) => (typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}));

export const leaseRenewRoute = declareRoute({
  method: "post",
  path: "/v1/leases/{id}/renew",
  tag: "Leases",
  summary: "Renew a lease",
  role: "agent",
  notes: "The body is optional; without a ttlMs the lease keeps its own width.",
  request: { params: leaseParamsSchema, optionalJson: renewBodySchema },
  reply: z.object({
    expiresAt: z.string(),
    leaseId: z.string(),
    notices: z.array(leaseNoticeSchema),
  }),
  errors: { 404: ["UNKNOWN_LEASE"] },
});

// why: `stdin` and `requesterId` also accept `null` and normalize it to omitted: the documented example sends them as `null`.
export const execBodySchema = z
  .object({
    tool: z.string().min(1),
    args: z.array(z.string()),
    stdin: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    requesterId: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .strict();

const execMessageSchema = sseMessage({
  error: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
  exit: z.object({ exitCode: z.number() }),
  output: z.object({ chunk: z.string(), stream: z.enum(["stdout", "stderr"]) }),
});

export const leaseExecRoute = declareRoute({
  method: "post",
  path: "/v1/leases/{id}/exec",
  tag: "Leases",
  summary: "Run a tool against the lease's device",
  role: "agent",
  notes:
    "Answers a stream of messages: output, then exit or error. A failure before the command starts is a plain JSON error.",
  request: { params: leaseParamsSchema, json: execBodySchema },
  stream: execMessageSchema,
  errors: { 404: ["UNKNOWN_LEASE"], 501: ["UNSUPPORTED_IN_GATEWAY_MODE"], 504: ["EXEC_TIMEOUT"] },
});

export const leaseRequestGetRoute = declareRoute({
  method: "get",
  path: "/v1/lease-requests/{id}",
  tag: "Lease requests",
  summary: "Read a lease request, optionally waiting for it to change",
  role: "agent",
  notes: "Its owner or an operator.",
  request: { params: leaseParamsSchema, query: waitQuerySchema },
  reply: leaseRequestReplySchema,
  errors: { 404: ["UNKNOWN_LEASE_REQUEST"] },
});

export const LEASE_ROUTES = [leaseRenewRoute, leaseExecRoute, leaseRequestGetRoute] as const;

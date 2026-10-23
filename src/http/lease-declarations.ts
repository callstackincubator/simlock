import { z } from "@hono/zod-openapi";

import {
  deviceClassSchema,
  deviceRecordSchema,
  imageTagSchema,
  leaseIdSchema,
  OPERATIONS,
  refuseModelWithClass,
  waitingRequestSchema,
} from "../contract/index.js";
import { declareRoute, firstValue, sseMessage } from "./routes.js";

const leaseParamsSchema = z.object({ id: z.string() });

const leasePayloadSchema = z.object({
  address: z.string().optional(),
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

const deviceUnhealthySchema = z.object({ event: z.literal("device_unhealthy") });
const deviceRecoveredSchema = z.object({
  attempts: z.number(),
  event: z.literal("device_recovered"),
});
const leaseLostSchema = z.object({ event: z.literal("lease_lost"), reason: z.string() });

const leaseNoticeSchema = z.discriminatedUnion("event", [
  deviceUnhealthySchema,
  deviceRecoveredSchema,
  leaseLostSchema,
]);

// why: `ttlMs` is read as unknown so that each way it can be wrong keeps its own whole-body message.
const renewBodySchema = z
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
const execBodySchema = z
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

export const leaseRequestBodySchema = z
  .object({
    allowDownload: z.boolean().optional(),
    class: deviceClassSchema.optional(),
    device: z.string().min(1).optional(),
    imageTag: imageTagSchema.optional(),
    leaseId: leaseIdSchema.optional(),
    mode: z.enum(["slim", "full"]).optional(),
    noWait: z.boolean().optional(),
    // why: forwarded, not dropped: the dispatcher's `lease.request` handler alone decides whether this token may set it.
    owner: z.string().min(1).optional(),
    os: z.string().min(1).optional(),
    physical: z.boolean().optional(),
    platform: z.enum(["ios", "android"]),
    timeoutMs: z.number().int().positive().optional(),
    ttlMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((body, context) =>
    refuseModelWithClass("device")({ model: body.device, class: body.class }, context),
  );

export const leaseRequestCreateRoute = declareRoute({
  method: "post",
  path: "/v1/lease-requests",
  tag: "Lease requests",
  summary: "Ask for a lease",
  role: "agent",
  notes: "Answers 201 with the request once the daemon has stored it; read it back by its id.",
  request: {
    headers: z.object({
      "Idempotency-Key": z
        .string()
        .optional()
        .openapi({ description: "A repeat of the same key answers the stored request." }),
    }),
    json: leaseRequestBodySchema,
  },
  reply: leaseRequestReplySchema,
  replyHeaders: z.object({ Location: z.string().openapi({ description: "The request's URL." }) }),
  status: 201,
  errors: {
    409: ["LEASE_ID_TAKEN", "REQUESTER_ALREADY_LEASED"],
    422: ["UNKNOWN_MODEL"],
    503: ["NO_CAPACITY"],
  },
  errorExtras: {
    409: { fields: { existingLeaseId: z.string().optional() } },
    503: {
      fields: {
        capacityReason: z
          .enum(["device-limit", "ram-budget", "global-running-limit", "platform-running-limit"])
          .optional(),
      },
      headers: {
        "Retry-After": z
          .string()
          .optional()
          .openapi({ description: "Seconds to wait before asking again; sent with NO_CAPACITY." }),
      },
    },
  },
});

export const requestsReplySchema = z.object({ requests: z.array(waitingRequestSchema) });

export const leaseRequestListRoute = declareRoute({
  method: "get",
  path: "/v1/lease-requests",
  tag: "Lease requests",
  summary: "Every request waiting for a device",
  role: "admin",
  reply: requestsReplySchema,
});

export const leaseRequestEventsRoute = declareRoute({
  method: "get",
  path: "/v1/lease-requests/{id}/events",
  tag: "Lease requests",
  summary: "Stream a lease request's stages",
  role: "agent",
  notes:
    "Its owner or an operator. A stream of messages, one per stage, each carrying the request; it ends at granted, failed or cancelled.",
  request: { params: leaseParamsSchema },
  stream: sseMessage({
    queued: leaseRequestViewSchema,
    downloading: leaseRequestViewSchema,
    reclaiming: leaseRequestViewSchema,
    provisioning: leaseRequestViewSchema,
    booting: leaseRequestViewSchema,
    granted: leaseRequestViewSchema,
    failed: leaseRequestViewSchema,
    cancelled: leaseRequestViewSchema,
  }),
  errors: { 404: ["UNKNOWN_LEASE_REQUEST"] },
});

export const leaseRequestCancelRoute = declareRoute({
  method: "delete",
  path: "/v1/lease-requests/{id}",
  tag: "Lease requests",
  summary: "Cancel a lease request",
  role: "agent",
  notes: "Its owner or an operator. Answers 204.",
  request: { params: leaseParamsSchema },
  status: 204,
  errors: { 404: ["UNKNOWN_LEASE_REQUEST"], 409: ["REQUEST_NOT_CANCELLABLE"] },
  errorExtras: { 409: { fields: { leaseId: z.string().optional() } } },
});

export const leaseListRoute = declareRoute({
  method: "get",
  path: "/v1/leases",
  tag: "Leases",
  summary: "The caller's leases; an operator sees every lease",
  role: "agent",
  reply: OPERATIONS["lease.list"].output,
});

export const leaseGetRoute = declareRoute({
  method: "get",
  path: "/v1/leases/{id}",
  tag: "Leases",
  summary: "Read one lease",
  role: "agent",
  notes: "A lease the caller does not own answers 404, as an unknown one does.",
  request: { params: leaseParamsSchema },
  reply: z.object({ lease: leasePayloadSchema }),
  errors: { 404: ["UNKNOWN_LEASE"] },
});

export const leaseEventsRoute = declareRoute({
  method: "get",
  path: "/v1/leases/{id}/events",
  tag: "Leases",
  summary: "Stream a lease's health notices",
  role: "agent",
  notes:
    "A lease the caller does not own answers 404. A stream of messages; it ends on lease_lost.",
  request: { params: leaseParamsSchema },
  stream: sseMessage({
    device_unhealthy: deviceUnhealthySchema,
    device_recovered: deviceRecoveredSchema,
    lease_lost: leaseLostSchema,
  }),
  errors: { 404: ["UNKNOWN_LEASE"] },
});

export const leaseReleaseRoute = declareRoute({
  method: "delete",
  path: "/v1/leases/{id}",
  tag: "Leases",
  summary: "Release a lease",
  role: "agent",
  request: { params: leaseParamsSchema },
  reply: z.object({
    device: z.object({ id: z.string(), state: deviceRecordSchema.shape.state }),
    released: z.literal(true),
  }),
  status: 202,
  errors: { 404: ["UNKNOWN_LEASE"] },
});

export const LEASE_ROUTES = [
  leaseRequestCreateRoute,
  leaseRequestListRoute,
  leaseRequestGetRoute,
  leaseRequestEventsRoute,
  leaseRequestCancelRoute,
  leaseListRoute,
  leaseGetRoute,
  leaseRenewRoute,
  leaseExecRoute,
  leaseEventsRoute,
  leaseReleaseRoute,
] as const;

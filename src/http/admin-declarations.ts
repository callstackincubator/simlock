import { z } from "@hono/zod-openapi";

import { eventEnvelopeSchema, OPERATIONS } from "../contract/index.js";
import { declareRoute, firstValue, platformQuerySchema, sseMessage } from "./routes.js";

const workerParamsSchema = z.object({ id: z.string() });

export const workerListRoute = declareRoute({
  method: "get",
  path: "/v1/workers",
  tag: "Workers",
  summary: "The workers the gateway holds; a worker lists itself",
  role: "admin",
  reply: OPERATIONS["worker.list"].output,
});

export const workerDrainRoute = declareRoute({
  method: "post",
  path: "/v1/workers/{id}/drain",
  tag: "Workers",
  summary: "Stop sending new leases to a worker",
  role: "admin",
  notes:
    "Takes no body. Gateway only: a worker answers 501 UNSUPPORTED_IN_WORKER_MODE. Its existing leases stay.",
  request: { params: workerParamsSchema },
  reply: OPERATIONS["worker.drain"].output,
  errors: { 404: ["UNKNOWN_WORKER"], 501: ["UNSUPPORTED_IN_WORKER_MODE"] },
});

export const workerUndrainRoute = declareRoute({
  method: "delete",
  path: "/v1/workers/{id}/drain",
  tag: "Workers",
  summary: "Send new leases to a drained worker again",
  role: "admin",
  notes: "Gateway only: a worker answers 501 UNSUPPORTED_IN_WORKER_MODE.",
  request: { params: workerParamsSchema },
  reply: OPERATIONS["worker.undrain"].output,
  errors: { 404: ["UNKNOWN_WORKER"], 501: ["UNSUPPORTED_IN_WORKER_MODE"] },
});

export const workerRemoveRoute = declareRoute({
  method: "delete",
  path: "/v1/workers/{id}",
  tag: "Workers",
  summary: "Forget a disconnected worker",
  role: "admin",
  notes: "Gateway only: a worker answers 501 UNSUPPORTED_IN_WORKER_MODE.",
  request: { params: workerParamsSchema },
  reply: OPERATIONS["worker.remove"].output,
  errors: { 409: ["WORKER_CONNECTED"], 501: ["UNSUPPORTED_IN_WORKER_MODE"] },
});

export const componentListRoute = declareRoute({
  method: "get",
  path: "/v1/components",
  tag: "Components",
  summary: "The simulator runtimes and system images on this machine",
  role: "agent",
  notes: "Worker only: a gateway answers 501 UNSUPPORTED_IN_GATEWAY_MODE.",
  request: { query: platformQuerySchema },
  reply: OPERATIONS["component.list"].output,
  errors: { 501: ["UNSUPPORTED_IN_GATEWAY_MODE"] },
});

const componentRemoveQuerySchema = z
  .object({ dryRun: firstValue(z.string().openapi({ enum: ["true", "false"] })).optional() })
  .superRefine((query, context) => {
    if (query.dryRun !== undefined && query.dryRun !== "true" && query.dryRun !== "false") {
      context.addIssue({ code: "custom", message: "dryRun must be true or false", path: [] });
    }
  });

export const componentRemoveRoute = declareRoute({
  method: "delete",
  path: "/v1/components/{platform}/{version}",
  tag: "Components",
  summary: "Remove an installed runtime or system image",
  role: "admin",
  notes:
    "Worker only: a gateway answers 501 UNSUPPORTED_IN_GATEWAY_MODE. The path values are checked by the daemon.",
  request: {
    params: z.object({ platform: z.string(), version: z.string() }),
    query: componentRemoveQuerySchema,
  },
  reply: OPERATIONS["component.remove"].output,
  errors: { 501: ["UNSUPPORTED_IN_GATEWAY_MODE"] },
});

export const tokenListRoute = declareRoute({
  method: "get",
  path: "/v1/tokens",
  tag: "Tokens",
  summary: "The token records, never a secret or a hash",
  role: "admin",
  reply: OPERATIONS["token.list"].output,
});

const eventsQuerySchema = z.object({
  before: firstValue(z.string()).optional(),
  limit: firstValue(z.string()).optional(),
  since: firstValue(z.string()).optional(),
});

export const eventsRoute = declareRoute({
  method: "get",
  path: "/v1/events",
  tag: "Events",
  summary: "Replay stored events, newest page first",
  role: "admin",
  notes:
    "`since` is a duration such as 5m; `before` and `limit` page back through the history and cannot be used with `since`.",
  request: { query: eventsQuerySchema },
  reply: z.object({ events: OPERATIONS["events.replay"].output }),
  errors: { 422: ["HISTORY_NOT_KEPT"], 503: ["HISTORY_UNAVAILABLE"] },
  errorExtras: { 422: { fields: { oldestTs: z.number().optional() } } },
});

export const eventsStreamRoute = declareRoute({
  method: "get",
  path: "/v1/events/stream",
  tag: "Events",
  summary: "Stream every event as it happens",
  role: "admin",
  notes:
    "A stream of messages, one per event: `event` is the event's name and `data` its envelope, whose `payload` is an open object. Each event's payload is in the Events reference, /simlock/docs/reference/events.",
  stream: z.object({ data: eventEnvelopeSchema, event: z.string() }),
});

const componentInstallBodySchema = z
  .object({
    platform: z.string(),
    version: z.string(),
    workers: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

const installProgressSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("waiting"), workerId: z.string().optional() }),
  z.object({
    stage: z.literal("downloading"),
    fraction: z.number().optional(),
    workerId: z.string().optional(),
  }),
]);

const installMessageSchema = sseMessage({
  progress: installProgressSchema,
  result: z.union([
    OPERATIONS["component.install"].output,
    OPERATIONS["worker.install-component"].output,
  ]),
  error: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
});

export const componentInstallRoute = declareRoute({
  method: "post",
  path: "/v1/components/install",
  tag: "Components",
  summary: "Install a simulator runtime or system image",
  role: "admin",
  notes:
    "Answers a stream of messages: progress, then result or error; a refusal before the install starts is a plain JSON error. Without `workers` the daemon installs here: worker only, a gateway answers 501 UNSUPPORTED_IN_GATEWAY_MODE. With `workers` a gateway relays the install to those workers (or all): gateway only, a worker answers 501 UNSUPPORTED_IN_WORKER_MODE; progress then names each workerId and result is `{results}`.",
  request: { json: componentInstallBodySchema },
  stream: installMessageSchema,
  errors: {
    403: ["DOWNLOADS_DISABLED"],
    404: ["UNKNOWN_WORKER"],
    422: ["NO_DRIVER"],
    501: ["UNSUPPORTED_IN_GATEWAY_MODE", "UNSUPPORTED_IN_WORKER_MODE"],
    503: ["WORKER_UNREACHABLE"],
    504: ["DOWNLOAD_TIMEOUT"],
  },
});

export const ADMIN_ROUTES = [
  workerListRoute,
  workerDrainRoute,
  workerUndrainRoute,
  workerRemoveRoute,
  componentListRoute,
  componentRemoveRoute,
  componentInstallRoute,
  tokenListRoute,
  eventsRoute,
  eventsStreamRoute,
] as const;

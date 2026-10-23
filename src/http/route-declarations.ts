import { z } from "@hono/zod-openapi";

import { deviceRecordSchema, OPERATIONS, statusDeviceSchema } from "../contract/index.js";
import { ADMIN_ROUTES } from "./admin-declarations.js";
import { LEASE_ROUTES } from "./lease-declarations.js";
import { declareRoute, firstValue, platformQuerySchema } from "./routes.js";

export const healthzRoute = declareRoute({
  method: "get",
  path: "/v1/healthz",
  tag: "System",
  summary: "Liveness check",
  role: "public",
  reply: z.object({ ok: z.literal(true) }),
});

export const statusRoute = declareRoute({
  method: "get",
  path: "/v1/status",
  tag: "System",
  summary: "The daemon's devices, leases and capacity",
  role: "agent",
  notes: "With an agent token, leases and waiting hold only that token's own.",
  reply: OPERATIONS["status.get"].output,
});

const deviceAddBodySchema = z.object({ id: z.string(), platform: z.string() }).strict();

export const deviceAddRoute = declareRoute({
  method: "post",
  path: "/v1/devices",
  tag: "Devices",
  summary: "Enroll a physical device",
  role: "admin",
  request: { json: deviceAddBodySchema },
  reply: OPERATIONS["device.add"].output,
  errors: {
    409: ["DEVICE_BUSY"],
    422: ["DEVICE_NOT_ENROLLABLE", "NO_DRIVER"],
    501: ["UNSUPPORTED_IN_GATEWAY_MODE"],
  },
});

export const catalogRoute = declareRoute({
  method: "get",
  path: "/v1/catalog",
  tag: "System",
  summary: "The platforms, runtimes and models a lease can ask for",
  role: "agent",
  request: { query: platformQuerySchema },
  reply: OPERATIONS["catalog.get"].output,
});

const statsQuerySchema = z
  .object({
    from: firstValue(z.string()).optional(),
    ledger: firstValue(z.string()).optional(),
    since: firstValue(z.string()).optional(),
    to: firstValue(z.string()).optional(),
  })
  .superRefine((query, context) => {
    if (query.ledger !== undefined && query.ledger !== "1") {
      context.addIssue({ code: "custom", message: "ledger must be 1", path: [] });
    }
  });

export const statsRoute = declareRoute({
  method: "get",
  path: "/v1/stats",
  tag: "System",
  summary: "Usage over a window of time",
  role: "admin",
  request: { query: statsQuerySchema },
  reply: OPERATIONS["usage.get"].output,
  errors: { 422: ["HISTORY_NOT_KEPT"], 503: ["HISTORY_UNAVAILABLE"] },
});

export const identityRoute = declareRoute({
  method: "get",
  path: "/v1/identity",
  tag: "System",
  summary: "Who the token in the request is",
  role: "agent",
  reply: OPERATIONS["identity.get"].output,
});

export const deviceRemoveRoute = declareRoute({
  method: "delete",
  path: "/v1/devices/{id}",
  tag: "Devices",
  summary: "Remove an enrolled device",
  role: "admin",
  request: { params: z.object({ id: z.string() }) },
  reply: OPERATIONS["device.remove"].output,
  errors: {
    404: ["UNKNOWN_DEVICE"],
    409: ["DEVICE_BUSY"],
    501: ["UNSUPPORTED_IN_GATEWAY_MODE"],
  },
});

export const devicesReplySchema = z.object({
  devices: z.union([z.array(deviceRecordSchema), z.array(statusDeviceSchema)]),
});

export const devicesRoute = declareRoute({
  method: "get",
  path: "/v1/devices",
  tag: "Devices",
  summary: "The devices this daemon holds",
  role: "admin",
  reply: devicesReplySchema,
});

export const DECLARED_ROUTES = [
  healthzRoute,
  statusRoute,
  catalogRoute,
  deviceAddRoute,
  deviceRemoveRoute,
  identityRoute,
  devicesRoute,
  statsRoute,
  ...LEASE_ROUTES,
  ...ADMIN_ROUTES,
] as const;

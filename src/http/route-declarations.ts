import { z } from "@hono/zod-openapi";

import { OPERATIONS } from "../contract/index.js";
import { declareRoute } from "./routes.js";

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
  reply: OPERATIONS["status.get"].output,
});

export const deviceAddBodySchema = z.object({ id: z.string(), platform: z.string() }).strict();

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

export const DECLARED_ROUTES = [healthzRoute, statusRoute, deviceAddRoute] as const;

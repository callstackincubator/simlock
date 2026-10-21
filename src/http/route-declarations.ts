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

export const DECLARED_ROUTES = [healthzRoute, statusRoute] as const;

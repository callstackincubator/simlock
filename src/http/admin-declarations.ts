import { z } from "@hono/zod-openapi";

import { OPERATIONS } from "../contract/index.js";
import { declareRoute, sseMessage } from "./routes.js";

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

export const ADMIN_ROUTES = [componentInstallRoute] as const;

import { OpenAPIHono } from "@hono/zod-openapi";

import type { OptionalModuleDefinition } from "../modules/index.js";
import { readPackageVersion } from "../ports/index.js";
import { DECLARED_ROUTES } from "./route-declarations.js";
import { BEARER_SCHEME } from "./routes.js";

export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

// why: no module carries route data until the stream task, so the definitions are not read yet.
export function buildOpenApiDocument(
  _modules: readonly OptionalModuleDefinition<unknown>[],
): OpenApiDocument {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", BEARER_SCHEME, {
    type: "http",
    scheme: "bearer",
  });
  for (const route of DECLARED_ROUTES) app.openAPIRegistry.registerPath(route);
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "simlock HTTP API", version: readPackageVersion() },
  });
}

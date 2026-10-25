import { OpenAPIHono } from "@hono/zod-openapi";

import type { OptionalModuleDefinition } from "../modules/index.js";
import { readPackageVersion } from "../ports/index.js";
import { moduleRoutes } from "./module-routes.js";
import { DECLARED_ROUTES } from "./route-declarations.js";
import { BEARER_SCHEME } from "./routes.js";

export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

export function buildOpenApiDocument(
  modules: readonly OptionalModuleDefinition<unknown>[],
): OpenApiDocument {
  const tags = modules
    .filter((definition) => definition.http !== undefined)
    .map((definition) => ({
      name: definition.name,
      description: `Served only when capabilities.${definition.name}.enabled is true.`,
    }));
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", BEARER_SCHEME, {
    type: "http",
    scheme: "bearer",
  });
  for (const route of DECLARED_ROUTES) app.openAPIRegistry.registerPath(route);
  for (const route of moduleRoutes(modules)) app.openAPIRegistry.registerPath(route);
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    ...(tags.length === 0 ? {} : { tags }),
    info: { title: "simlock HTTP API", version: readPackageVersion() },
  });
}

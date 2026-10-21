import type { OpenAPIHono } from "@hono/zod-openapi";

import type { OptionalModuleDefinition } from "../modules/index.js";

export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

export function buildOpenApiDocument(
  _modules: readonly OptionalModuleDefinition<unknown>[],
): OpenApiDocument {
  return { openapi: "3.1.0", info: { title: "", version: "" } };
}

import type { OpenApiDocument } from "../http/openapi.js";

export function openApiDocument(): OpenApiDocument {
  return { openapi: "3.1.0", info: { title: "", version: "" } };
}

export async function writeOpenApiDocument(
  _file: string,
  _build: () => OpenApiDocument = openApiDocument,
): Promise<void> {}

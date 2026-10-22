import { buildOpenApiDocument, type OpenApiDocument } from "../http/openapi.js";
import { optionalModules } from "../module-registry/index.js";
import { NodeFilesystem } from "../ports/index.js";

export function openApiDocument(): OpenApiDocument {
  return buildOpenApiDocument(optionalModules);
}

export async function writeOpenApiDocument(
  file: string,
  build: () => OpenApiDocument = openApiDocument,
): Promise<void> {
  const document = build();
  await new NodeFilesystem().writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`);
}

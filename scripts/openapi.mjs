#!/usr/bin/env node
// `pnpm openapi <file>`: writes the OpenAPI document of the HTTP API to <file>. It reads the
// compiled daemon, so `build:daemon` runs first; a failure writes no file and exits non-zero.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const file = process.argv[2];
if (file === undefined) {
  console.error("usage: pnpm openapi <file>");
  process.exit(2);
}

const root = new URL("..", import.meta.url);
const { writeOpenApiDocument } = await import(
  pathToFileURL(resolve(root.pathname, "dist/daemon/openapi.js")).href
);
try {
  await writeOpenApiDocument(resolve(file));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

#!/usr/bin/env node
// Post-build check for the HTTP API reference: run it after `astro build`, from anywhere.
// It exits 1 naming the first check that fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const site = new URL("..", import.meta.url).pathname;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function fail(message) {
  console.error(`check-openapi: ${message}`);
  process.exit(1);
}

// why: a tag that has a description gets a page under operations/tags; it is not an operation.
function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "tags"
        ? []
        : pages(join(dir, entry.name))
      : entry.name.endsWith(".html")
        ? [entry]
        : [],
  );
}

// why: a single replace can leave "<script" behind when tags nest ("<<b>script>"), so strip until the text stops changing.
function text(html) {
  let previous;
  let current = html;
  do {
    previous = current;
    current = previous.replace(/<[^>]*>/g, "");
  } while (current !== previous);
  return current.trim();
}

// why: the sidebar is plain nested <details><summary>label</summary>…</details>; this reads that tree.
function groups(html) {
  const root = { label: "", children: [] };
  const stack = [root];
  for (const token of html.matchAll(/<details\b[^>]*>|<\/details>|<summary\b[^>]*>(.*?)<\/summary>/gs)) {
    if (token[0].startsWith("</details")) stack.pop();
    else if (token[0].startsWith("<details")) {
      const group = { label: "", children: [] };
      stack.at(-1).children.push(group);
      stack.push(group);
    } else stack.at(-1).label = text(token[1]);
  }
  return root;
}

const publicFile = join(site, "public/openapi.json");
const builtFile = join(site, "dist/openapi.json");
if (!existsSync(builtFile)) fail("dist/openapi.json does not exist");
if (readFileSync(builtFile, "utf8") !== readFileSync(publicFile, "utf8")) {
  fail("dist/openapi.json differs from public/openapi.json");
}
const document = JSON.parse(readFileSync(builtFile, "utf8"));

const overview = join(site, "dist/docs/reference/http-api.html");
if (!existsSync(overview)) fail("dist/docs/reference/http-api.html does not exist");

const operations = Object.values(document.paths).flatMap((item) =>
  METHODS.filter((method) => item[method] !== undefined).map((method) => item[method]),
);
const operationsDir = join(site, "dist/docs/reference/http-api/operations");
const built = existsSync(operationsDir) ? pages(operationsDir).length : 0;
if (built !== operations.length) {
  fail(`${built} operation pages under http-api/operations, the document has ${operations.length}`);
}

const reference = groups(readFileSync(overview, "utf8")).children.find(
  (group) => group.label === "Reference",
);
if (reference === undefined) fail('the sidebar has no "Reference" group');
const api = reference.children.find((group) => group.label === "HTTP API reference");
if (api === undefined) fail('the Reference group has no "HTTP API reference" group');
const tags = [...new Set(operations.flatMap((operation) => operation.tags ?? []))];
const labels = api.children.map((group) => group.label);
for (const tag of tags) {
  if (!labels.includes(tag)) fail(`the "HTTP API reference" group has no sub-group for tag "${tag}"`);
}
if (labels.length !== tags.length) {
  fail(`the "HTTP API reference" group has sub-groups ${labels.join(", ")}, the document has tags ${tags.join(", ")}`);
}
console.log(`check-openapi: ${operations.length} operations, ${tags.length} tags: ok`);

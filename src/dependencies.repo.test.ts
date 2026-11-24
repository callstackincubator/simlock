import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const declared = readJson(join(REPO_ROOT, "package.json"))["dependencies"] as Record<
  string,
  string
>;

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

describe("runtime dependencies", () => {
  it("installs each exactly pinned runtime dependency at the version package.json pins", () => {
    const pinned = Object.entries(declared).filter(([, spec]) => EXACT_VERSION.test(spec));
    expect(pinned.map(([name]) => name)).toEqual(
      expect.arrayContaining(["@hono/node-server", "@modelcontextprotocol/sdk", "ws"]),
    );

    const installed = Object.fromEntries(
      pinned.map(([name]) => [
        name,
        readJson(join(REPO_ROOT, "node_modules", name, "package.json"))["version"],
      ]),
    );

    expect(installed).toEqual(Object.fromEntries(pinned));
  });
});

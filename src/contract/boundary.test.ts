import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const contractDir = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_IMPORT_PREFIXES = [
  "../core",
  "../daemon/",
  "../daemon.js",
  "../drivers",
  "../http",
  "../cli",
  "../mcp",
  "../ports",
];

/**
 * ADR 0003 §1's central constraint: the contract module imports nothing from `core`,
 * `daemon`, `drivers`, `http`, `cli`, `mcp`, or `ports`. This is what keeps core domain
 * records off the public package surface. Enforced here at the source-text level (a relative
 * import string check) rather than via a build/lint rule, so it runs under plain `vitest`
 * with no extra tooling.
 */
describe("contract module boundary", () => {
  const sourceFiles = readdirSync(contractDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

  it("found the contract's own source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)("%s imports nothing outside the contract module", (fileName) => {
    const contents = readFileSync(join(contractDir, fileName), "utf8");
    const importLines = contents
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line) || /^\s*export\s+\*\s+from/.test(line));

    for (const line of importLines) {
      const match = /from\s+["']([^"']+)["']/.exec(line);
      if (match === null) continue;
      const specifier: string | undefined = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith(".")) {
        // Relative imports must stay inside this directory (e.g. "./schemas.js"), never climb
        // out to a sibling module.
        expect(specifier.startsWith("./")).toBe(true);
        continue;
      }
      for (const forbidden of FORBIDDEN_IMPORT_PREFIXES) {
        expect(specifier.startsWith(forbidden)).toBe(false);
      }
    }
  });
});

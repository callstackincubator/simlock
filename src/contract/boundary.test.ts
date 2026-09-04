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

    // Scanned over the *whole* file text (comments stripped first), not line-by-line filtered
    // to lines matching `^\s*import\s`: the project's formatter breaks any import with more
    // than one named binding across multiple lines (e.g. `import {\n  Foo,\n  Bar,\n} from
    // "../core/index.js";`), and for such an import the `import {` line carries no `from` while
    // the `} from "../core/index.js";` line never starts with `import` at all -- a line-based
    // filter is blind to exactly the import style this repo writes. Comments are stripped so a
    // `from "../core/..."` mentioned only in prose (e.g. this file's own doc comments) cannot
    // produce a false positive.
    for (const specifier of importSpecifiers(stripComments(contents))) {
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

/** Strips `/* ... *\/` block comments and `// ...` line comments so a specifier that appears
 * only in prose (a doc comment illustrating a forbidden import) is never mistaken for a real
 * one. Good enough for this repo's source, which never puts `//` inside an import specifier
 * string. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every `from "…"` (or `from '…'`) specifier anywhere in the (comment-stripped) text --
 * catches both single-line and formatter-wrapped multi-line `import { ... } from "…"` /
 * `export * from "…"` statements, since the `from "…"` clause always lands on one line even
 * when the binding list above it does not. */
function importSpecifiers(contents: string): string[] {
  const specifiers: string[] = [];
  const pattern = /from\s*["']([^"']+)["']/g;
  for (const match of contents.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

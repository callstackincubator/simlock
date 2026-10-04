import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { importsOf, isUnder, sourceFilesRecursive } from "../test-support/imports.js";

const contractDir = dirname(fileURLToPath(import.meta.url));

/**
 * ADR 0003 §1's central constraint: the contract module imports nothing from `core`,
 * `daemon`, `drivers`, `http`, `cli`, `mcp`, or `ports`. This is what keeps core domain
 * records off the public package surface. Enforced here at the source-text level rather than via
 * a build/lint rule, so it runs under plain `vitest` with no extra tooling.
 *
 * Stated as the stronger rule that implies it: every relative import, resolved against the file
 * that wrote it, stays inside `src/contract/`. Packages (`zod`) are not relative and pass. The
 * shared scanner sees dynamic and side-effect imports and every subdirectory, and resolves the
 * specifier, so `"./../core/index.js"` counts as leaving the module.
 */
describe("contract module boundary", () => {
  const sourceFiles = sourceFilesRecursive(contractDir);

  it("found the contract's own source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("imports nothing outside the contract module", () => {
    const escapes = importsOf(sourceFiles).filter(
      ({ specifier, normalized }) => specifier.startsWith(".") && !isUnder(normalized, "contract"),
    );

    expect(escapes.map(({ file, specifier }) => `${file} imports "${specifier}"`)).toEqual([]);
  });
});

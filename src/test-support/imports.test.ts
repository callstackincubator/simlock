import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  importSpecifiers,
  importsOf,
  isUnder,
  normalizeSpecifier,
  sourceFilesRecursive,
  srcDir,
  stripComments,
} from "./imports.js";

const gatewayDir = join(srcDir, "gateway");

describe("sourceFilesRecursive", () => {
  // A flat `readdirSync` never looked inside a subdirectory at all, so a module placed under one
  // skipped a boundary suite silently rather than failing it.
  it("descends into a subdirectory, and still skips test files there", () => {
    const dir = mkdtempSync(join(tmpdir(), "simlock-boundary-test-"));
    try {
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "top.ts"), "export {};");
      writeFileSync(join(dir, "nested", "deep.ts"), "export {};");
      writeFileSync(join(dir, "nested", "deep.test.ts"), "export {};");

      const found = sourceFilesRecursive(dir)
        .map((path) => path.slice(dir.length + 1))
        .sort();

      expect(found).toEqual(["nested/deep.ts", "top.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeSpecifier / isUnder", () => {
  // A literal `"../core"` prefix check is only ever true for a file directly under one module
  // directory: `src/gateway/routing/policy.ts` reaches the same module as
  // `"../../core/registry.js"`, one `..` longer. Resolving both against the file's own directory
  // into a path relative to `src/` is what makes them compare equal.
  it("resolves a nested file's longer relative path to the same normalized module as a top-level one", () => {
    const topLevel = normalizeSpecifier(gatewayDir, "../core/registry.js");
    const nested = normalizeSpecifier(join(gatewayDir, "routing"), "../../core/registry.js");

    expect(nested).toBe(topLevel);
    expect(nested).toBe("core/registry.js");
    expect(isUnder(nested, "core")).toBe(true);
  });

  // A `startsWith("./")` check reads this as "inside this directory"; it climbs straight out.
  it("resolves a specifier that starts with ./ but climbs out of the directory", () => {
    const normalized = normalizeSpecifier(join(srcDir, "contract"), "./../core/index.js");

    expect(normalized).toBe("core/index.js");
    expect(isUnder(normalized, "contract")).toBe(false);
  });

  it("leaves a non-relative specifier (a package, a node: built-in) unchanged", () => {
    expect(normalizeSpecifier(gatewayDir, "zod")).toBe("zod");
    expect(normalizeSpecifier(gatewayDir, "node:fs")).toBe("node:fs");
  });

  it("does not flag a same-directory or sibling-module import as forbidden", () => {
    const normalized = normalizeSpecifier(gatewayDir, "./worker-registry.js");
    expect(isUnder(normalized, "core")).toBe(false);
  });

  it("matches a directory's barrel and its files, but not a sibling whose name it prefixes", () => {
    expect(isUnder("core", "core")).toBe(true);
    expect(isUnder("core/registry.js", "core")).toBe(true);
    expect(isUnder("core-extras/registry.js", "core")).toBe(false);
  });
});

describe("importSpecifiers", () => {
  // A dynamic `await import(...)` routed around every boundary check without this.
  it("catches a dynamic import, not just a static `from`", () => {
    expect(importSpecifiers('const mod = await import("../core/registry.js");')).toContain(
      "../core/registry.js",
    );
  });

  it("catches a bare side-effect import with no `from` clause", () => {
    expect(importSpecifiers('import "../core/registry.js";')).toContain("../core/registry.js");
  });

  it("catches a re-export", () => {
    expect(importSpecifiers('export { x } from "../core/registry.js";')).toEqual([
      "../core/registry.js",
    ]);
  });

  it("still catches an ordinary static import exactly once", () => {
    expect(importSpecifiers('import { x } from "../core/registry.js";')).toEqual([
      "../core/registry.js",
    ]);
  });

  it("sees nothing in a comment once comments are stripped", () => {
    expect(
      importSpecifiers(stripComments('// import "../core/a.js";\n/* from "../core/b.js" */')),
    ).toEqual([]);
  });
});

describe("importsOf", () => {
  it("names each import's file relative to the root, its specifier, and where it resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "simlock-boundary-test-"));
    try {
      mkdirSync(join(dir, "gateway", "routing"), { recursive: true });
      writeFileSync(
        join(dir, "gateway", "routing", "policy.ts"),
        'import { a } from "./rank.js";\nconst b = await import("../../core/registry.js");\n',
      );

      expect(importsOf(sourceFilesRecursive(dir), dir)).toEqual([
        {
          file: "gateway/routing/policy.ts",
          normalized: "gateway/routing/rank.js",
          specifier: "./rank.js",
        },
        {
          file: "gateway/routing/policy.ts",
          normalized: "core/registry.js",
          specifier: "../../core/registry.js",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

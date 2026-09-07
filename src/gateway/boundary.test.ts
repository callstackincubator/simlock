import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const daemonDir = join(dirname(gatewayDir), "daemon");

/**
 * ADR 0005 §33: "`src/gateway/` imports nothing from `drivers`, and from `core` only the
 * platform-agnostic queue and bus modules it reuses; never the registry, capacity, or lifecycle
 * modules (enforced like `src/contract/boundary.test.ts`)."
 *
 * In this PR the gateway reuses nothing from `core` at all -- the fleet queue arrives with #118
 * -- so the allowance is written as an explicit list rather than a blanket "core is fine": a
 * gateway that starts importing `../core/registry.js` should fail here, and a later PR adding
 * `../core/wait-queue.js` should have to say so in this list rather than silently widening the
 * boundary. `src/http` is off limits for the same reason (`GatewayTokenStore` is a structural
 * interface precisely so the token store need not be imported), as are `src/cli`, `src/mcp` and
 * `src/drivers`.
 */
const FORBIDDEN_IMPORT_PREFIXES = ["../core", "../drivers", "../http", "../cli", "../mcp"];

/**
 * The only `src/daemon` module the gateway may import: the transport-facing dispatch contract
 * (`DispatchSession`, `DispatchError`, `runDispatch`). It is core-free by construction -- see
 * the second test below, which asserts exactly that, so this allowance cannot become a back
 * door into the worker's engine.
 */
const ALLOWED_DAEMON_IMPORTS = ["../daemon/dispatch.js"];

/**
 * Recursive and by relative path (M4): a flat, non-recursive listing let a future subdirectory
 * under `src/gateway/` skip this test's notice entirely, silently, the moment one was added --
 * exactly the kind of gap that should fail loudly instead. `recursive: true` is Node 20+; the
 * repo requires Node 22.
 */
function sourceFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("gateway module boundary", () => {
  const sourceFiles = sourceFilesRecursive(gatewayDir);

  it("found the gateway's own source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles.map((path) => [path.slice(gatewayDir.length + 1), path] as const))(
    "%s imports no engine module",
    (relativePath, filePath) => {
      const contents = readFileSync(filePath, "utf8");

      for (const specifier of importSpecifiers(stripComments(contents))) {
        for (const forbidden of FORBIDDEN_IMPORT_PREFIXES) {
          expect({
            fileName: relativePath,
            specifier,
            startsWith: specifier.startsWith(forbidden),
          }).toEqual({ fileName: relativePath, specifier, startsWith: false });
        }
        if (specifier.startsWith("../daemon")) {
          expect(ALLOWED_DAEMON_IMPORTS).toContain(specifier);
        }
      }
    },
  );

  it("the one daemon module the gateway imports is itself free of core", () => {
    const contents = stripComments(readFileSync(join(daemonDir, "dispatch.ts"), "utf8"));

    for (const specifier of importSpecifiers(contents)) {
      expect(specifier.startsWith("../core")).toBe(false);
      expect(specifier.startsWith("../drivers")).toBe(false);
      expect(specifier.startsWith("../http")).toBe(false);
    }
  });
});

describe("sourceFilesRecursive", () => {
  // M4: the other half of the gap -- a flat `readdirSync` never looked inside a subdirectory at
  // all, so a module placed under one skipped this whole suite silently rather than failing it.
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

describe("importSpecifiers", () => {
  // M4: the gap the first review round found -- a dynamic `await import(...)` routed around
  // every check above without either of these.
  it("catches a dynamic import, not just a static `from`", () => {
    expect(importSpecifiers('const mod = await import("../core/registry.js");')).toContain(
      "../core/registry.js",
    );
  });

  it("catches a bare side-effect import with no `from` clause", () => {
    expect(importSpecifiers('import "../core/registry.js";')).toContain("../core/registry.js");
  });

  it("still catches an ordinary static import exactly once", () => {
    expect(importSpecifiers('import { x } from "../core/registry.js";')).toEqual([
      "../core/registry.js",
    ]);
  });
});

/** Strips block and line comments so a specifier that appears only in prose (a doc comment
 * naming a forbidden import, as several in this module do) is never mistaken for a real one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Every module specifier a static `import ... from "…"`, a bare side-effect `import "…"`, a
 * re-export (`export ... from "…"`), or a dynamic `await import("…")` names, in the
 * (comment-stripped) text. Formatter-wrapped multi-line static imports are still caught because
 * the `from "…"` clause always lands on one line; the dynamic form is its own pattern (M4) --
 * without it, a boundary this test enforces on every static import could be routed around with
 * one `await import("../core/registry.js")` and this suite would stay green.
 */
function importSpecifiers(contents: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/(?:from|import)\s*["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']/g];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

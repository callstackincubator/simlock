import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(gatewayDir);
const daemonDir = join(srcDir, "daemon");

/**
 * ADR 0005 §33: "`src/gateway/` imports nothing from `drivers`, and from `core` only the
 * platform-agnostic queue and bus modules it reuses; never the registry, capacity, or lifecycle
 * modules (enforced like `src/contract/boundary.test.ts`)."
 *
 * In this PR the gateway reuses nothing from `core` at all -- the fleet queue arrives with #118
 * -- so the allowance is written as an explicit list rather than a blanket "core is fine": a
 * gateway that starts importing `core/registry.js` should fail here, and a later PR adding
 * `core/wait-queue.js` should have to say so in this list rather than silently widening the
 * boundary. `src/http` is off limits for the same reason (`GatewayTokenStore` is a structural
 * interface precisely so the token store need not be imported), as are `src/cli`, `src/mcp` and
 * `src/drivers`.
 *
 * Named as top-level directories under `src/`, matched against a specifier normalised relative
 * to `src/` (see `normalizeSpecifier`) rather than against the raw text of the specifier -- a
 * literal `"../core"` prefix check (C2) only catches an import written from a file directly
 * under `src/gateway/`; a nested module (`src/gateway/routing/policy.ts`, which #118 adds)
 * reaches core as `"../../core/registry.js"`, which does not start with `"../core"`, so the
 * check silently stopped applying to exactly the files a subdirectory newly reaches.
 */
const FORBIDDEN_IMPORT_DIRS = ["core", "drivers", "http", "cli", "mcp"];

/**
 * The only `src/daemon` module the gateway may import: the transport-facing dispatch contract
 * (`DispatchSession`, `DispatchError`, `runDispatch`). It is core-free by construction -- see
 * the second test below, which asserts exactly that, so this allowance cannot become a back
 * door into the worker's engine. Written normalised (relative to `src/`) for the same reason as
 * `FORBIDDEN_IMPORT_DIRS` above.
 */
const ALLOWED_DAEMON_IMPORTS = ["daemon/dispatch.js"];

/**
 * A relative import specifier, resolved against the directory of the file that wrote it and
 * expressed relative to `src/` -- e.g. `"../../core/registry.js"` from
 * `src/gateway/routing/policy.ts` becomes `"core/registry.js"`, exactly like
 * `"../core/registry.js"` from `src/gateway/policy.ts` does. A non-relative specifier (an npm
 * package, a `node:` built-in) is returned unchanged: it can never resolve inside `src/`, so no
 * prefix check below will ever match it.
 */
function normalizeSpecifier(fileDir: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = posix.normalize(posix.join(fileDir, specifier));
  return posix.relative(srcDir, resolved);
}

/** Whether a normalised specifier names a module inside the top-level `src/` directory `dir` --
 * `dir` itself (an import of its barrel, `"core"` with no further path) or anything under it. */
function isUnder(normalized: string, dir: string): boolean {
  return normalized === dir || normalized.startsWith(`${dir}/`);
}

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
      const fileDir = dirname(filePath);

      for (const specifier of importSpecifiers(stripComments(contents))) {
        const normalized = normalizeSpecifier(fileDir, specifier);
        for (const forbidden of FORBIDDEN_IMPORT_DIRS) {
          expect({
            fileName: relativePath,
            normalized,
            specifier,
            matchesForbiddenDir: isUnder(normalized, forbidden),
          }).toEqual({
            fileName: relativePath,
            normalized,
            specifier,
            matchesForbiddenDir: false,
          });
        }
        if (isUnder(normalized, "daemon")) {
          expect(ALLOWED_DAEMON_IMPORTS).toContain(normalized);
        }
      }
    },
  );

  it("the one daemon module the gateway imports is itself free of core", () => {
    const contents = stripComments(readFileSync(join(daemonDir, "dispatch.ts"), "utf8"));

    for (const specifier of importSpecifiers(contents)) {
      const normalized = normalizeSpecifier(daemonDir, specifier);
      expect(isUnder(normalized, "core")).toBe(false);
      expect(isUnder(normalized, "drivers")).toBe(false);
      expect(isUnder(normalized, "http")).toBe(false);
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

describe("normalizeSpecifier / isUnder", () => {
  // C2: the round's title/body tell -- the old check compared the raw specifier text to a
  // literal `"../core"` prefix, which is only ever true for a file directly under
  // `src/gateway/`. `src/gateway/routing/policy.ts` (a subdirectory #118 adds) reaches the same
  // module as `"../../core/registry.js"`, one `..` longer, and a bare `startsWith` check does
  // not know the two name the same forbidden module. Resolving both against the file's own
  // directory into a path relative to `src/` is what makes them compare equal.
  it("resolves a nested file's longer relative path to the same normalized module as a top-level one", () => {
    const topLevel = normalizeSpecifier(gatewayDir, "../core/registry.js");
    const nested = normalizeSpecifier(join(gatewayDir, "routing"), "../../core/registry.js");

    expect(nested).toBe(topLevel);
    expect(nested).toBe("core/registry.js");
    expect(isUnder(nested, "core")).toBe(true);
  });

  it("leaves a non-relative specifier (a package, a node: built-in) unchanged", () => {
    expect(normalizeSpecifier(gatewayDir, "zod")).toBe("zod");
    expect(normalizeSpecifier(gatewayDir, "node:fs")).toBe("node:fs");
  });

  it("does not flag a same-directory or sibling-module import as forbidden", () => {
    const normalized = normalizeSpecifier(gatewayDir, "./worker-registry.js");
    expect(isUnder(normalized, "core")).toBe(false);
  });
});

describe("gateway module boundary regression fixtures", () => {
  // C2, made concrete: this is exactly the file #118 adds, reduced to the one line that matters.
  // Against the pre-fix `specifier.startsWith("../core")` check, this import passes silently --
  // `"../../core/registry.js"` does not start with `"../core"` -- even though it reaches the
  // exact module the boundary exists to keep out.
  it("catches a nested module importing core through a longer relative path", () => {
    const nestedDir = join(gatewayDir, "routing");
    const specifier = "../../core/registry.js";
    const normalized = normalizeSpecifier(nestedDir, specifier);

    expect(FORBIDDEN_IMPORT_DIRS.some((forbidden) => isUnder(normalized, forbidden))).toBe(true);
  });

  // And the matching allowlist gap: `"../../daemon/dispatcher.js"` does not start with
  // `"../daemon"` either, so the pre-fix allowlist branch was never entered for a nested file --
  // it would neither pass as allowed nor fail as forbidden, just vanish from the check entirely.
  it("still recognizes a nested module's daemon import as a daemon import to check against the allowlist", () => {
    const nestedDir = join(gatewayDir, "routing");
    const normalized = normalizeSpecifier(nestedDir, "../../daemon/dispatcher.js");

    expect(isUnder(normalized, "daemon")).toBe(true);
    expect(ALLOWED_DAEMON_IMPORTS).not.toContain(normalized);
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

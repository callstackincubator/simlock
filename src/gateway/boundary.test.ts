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
 * `drivers`, `http`, `cli`, and `mcp` stay wholesale forbidden -- `src/http` for the same reason
 * as always (`GatewayTokenStore` is a structural interface precisely so the token store need not
 * be imported). `core` is *not* in this list any more: #118 is the "later PR adding
 * `core/wait-queue.js`" the old comment here predicted, and it has to say so explicitly rather
 * than silently widening the boundary -- see `ALLOWED_CORE_IMPORTS` below, checked the same way
 * `ALLOWED_DAEMON_IMPORTS` already was.
 *
 * Named as top-level directories under `src/`, matched against a specifier normalised relative
 * to `src/` (see `normalizeSpecifier`) rather than against the raw text of the specifier -- a
 * literal `"../core"` prefix check (C2) only catches an import written from a file directly
 * under `src/gateway/`; a nested module (`src/gateway/routing/policy.ts`, which #118 adds)
 * reaches core as `"../../core/registry.js"`, which does not start with `"../core"`, so the
 * check silently stopped applying to exactly the files a subdirectory newly reaches.
 */
const FORBIDDEN_IMPORT_DIRS = ["drivers", "http", "cli", "mcp"];

/**
 * The only `src/daemon` module the gateway may import: the transport-facing dispatch contract
 * (`DispatchSession`, `DispatchError`, `runDispatch`). It is core-free by construction -- see
 * the second test below, which asserts exactly that, so this allowance cannot become a back
 * door into the worker's engine. Written normalised (relative to `src/`) for the same reason as
 * `FORBIDDEN_IMPORT_DIRS` above.
 */
const ALLOWED_DAEMON_IMPORTS = ["daemon/dispatch.js"];

/**
 * #118's fleet queue and its ownership check reuse `core`'s platform-agnostic FIFO
 * (`wait-queue.js`) and short critical-section serializer (`serialized-decision.js`) rather than
 * forking either -- ADR 0005 §33's "only the platform-agnostic queue and bus modules it reuses".
 * `domain.js` and `driver.js` are here too, explicitly, as the doc comment on the old
 * (now-removed) blanket `core` entry above asked the PR that widened this list to do: they are
 * `wait-queue.js`'s own transitive *type* imports (`DeviceRecord`/`LeaseRecord`/`DeviceSpec` and
 * `DeviceRequest`), which the fleet queue and coordinator need to name the same shapes wait-queue
 * itself is typed against rather than redeclaring them. Neither module is the registry, capacity,
 * or lifecycle engine §33 keeps off limits -- `domain.js` is pure data shapes and a spec-equality
 * predicate, `driver.js` is interface declarations only.
 */
const ALLOWED_CORE_IMPORTS = [
  "core/wait-queue.js",
  "core/serialized-decision.js",
  "core/domain.js",
  "core/driver.js",
];

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
        if (isUnder(normalized, "core")) {
          expect(ALLOWED_CORE_IMPORTS).toContain(normalized);
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
  // C2, made concrete: a hypothetical nested module reaching for a forbidden `core` module
  // through a longer relative path. Against the pre-fix `specifier.startsWith("../core")`
  // check, this import passed silently -- `"../../core/registry.js"` does not start with
  // `"../core"` -- even though it reaches exactly the kind of module the boundary exists to
  // keep out. `core/registry.js` is the registry itself, never in `ALLOWED_CORE_IMPORTS` (only
  // `wait-queue.js`/`serialized-decision.js`/`domain.js`/`driver.js` are, per #118) -- so a
  // nested file reaching it is caught the same way the daemon-allowlist gap below is: recognized
  // as `core`, and absent from the allowlist that governs it.
  it("catches a nested module importing core through a longer relative path", () => {
    const nestedDir = join(gatewayDir, "routing");
    const specifier = "../../core/registry.js";
    const normalized = normalizeSpecifier(nestedDir, specifier);

    expect(isUnder(normalized, "core")).toBe(true);
    expect(ALLOWED_CORE_IMPORTS).not.toContain(normalized);
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

/**
 * ADR 0003 §10/PR description: "the public surface must expose contract types only -- core
 * domain records (`DeviceRecord`, `LeaseRecord`, `LeaseGrant`) stay private". This compiles
 * `simlock/client`'s and `simlock/admin`'s entry points with declaration-only emit (via a
 * throwaway `tsc -p` invocation restricted to just those two root files, so only their actual
 * import closure gets emitted -- not a shelled-out `pnpm run build` of the whole package, and
 * not dependent on one having already run) and asserts none of the emitted `.d.ts` files ever
 * import from `src/core`, `src/daemon`, `src/drivers`, `src/http`, `src/cli`, or `src/mcp`.
 * Mirrors `src/contract/boundary.test.ts`'s source-text approach, but checked at the compiled
 * public-surface boundary instead of the contract module's own imports -- the actual guarantee
 * this test exists to prove is about what a *consumer* of the published package sees, which is
 * the emitted declarations, not the source.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "/core/",
  "/daemon/",
  "/daemon.js",
  "/drivers/",
  "/http/",
  "/cli/",
  "/mcp/",
];

let outDir: string;
let dtsFiles: Array<{ readonly path: string; readonly contents: string }>;

describe("public package surface (simlock/client, simlock/admin)", () => {
  let tmpTsconfigPath: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "simlock-surface-"));
    // Written inside the repo root (not the tmp outDir) so `"types": ["node"]` and everything
    // else in the extended `tsconfig.json` still resolves against this project's own
    // `node_modules` -- TS resolves package/type-root lookups relative to the config file's own
    // directory, not the directory of the config it extends.
    tmpTsconfigPath = join(repoRoot, ".simlock-surface-tsconfig.json");
    writeFileSync(
      tmpTsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { declaration: true, emitDeclarationOnly: true, outDir },
        files: ["src/client/index.ts", "src/admin/index.ts"],
        include: [],
      }),
    );
    const tscBin = join(repoRoot, "node_modules", ".bin", "tsc");
    execFileSync(tscBin, ["-p", tmpTsconfigPath], { cwd: repoRoot, stdio: "pipe" });
    dtsFiles = collectDtsFiles(outDir).map((path) => ({
      contents: readFileSync(path, "utf8"),
      path,
    }));
  }, 60_000);

  afterAll(() => {
    rmSync(outDir, { force: true, recursive: true });
    rmSync(tmpTsconfigPath, { force: true });
  });

  it("compiles both entry points and emits declarations for each", () => {
    expect(dtsFiles.some((file) => file.path.endsWith(join("client", "index.d.ts")))).toBe(true);
    expect(dtsFiles.some((file) => file.path.endsWith(join("admin", "index.d.ts")))).toBe(true);
  });

  it("never imports a core/daemon/drivers-private module from the compiled public surface", () => {
    expect(dtsFiles.length).toBeGreaterThan(0);
    for (const file of dtsFiles) {
      for (const specifier of importSpecifiers(file.contents)) {
        for (const forbidden of FORBIDDEN_IMPORT_SUBSTRINGS) {
          expect(
            specifier.includes(forbidden),
            `${file.path} imports "${specifier}", which references forbidden "${forbidden}"`,
          ).toBe(false);
        }
      }
    }
  });
});

/** Import/re-export specifiers only -- e.g. from `import("../core/index.js").Foo` or
 * `export * from "./x.js"` -- deliberately not a plain substring scan of the whole file, which
 * would false-positive on prose in a carried-over JSDoc comment (e.g. a `.d.ts` comment that
 * merely *mentions* `src/http/errors.ts` in passing, as `errors.ts` does today). */
function importSpecifiers(contents: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s+["']([^"']+)["']|import\(["']([^"']+)["']\))/g;
  for (const match of contents.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function collectDtsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectDtsFiles(full));
    else if (entry.name.endsWith(".d.ts")) results.push(full);
  }
  return results;
}

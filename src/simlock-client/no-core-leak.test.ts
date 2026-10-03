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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importsOf, isUnder, sourceFilesRecursive } from "../test-support/imports.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/** Top-level `src/` directories the emitted declarations must never reach, matched against each
 * specifier resolved relative to the emit root (which mirrors `src/`). */
const FORBIDDEN_IMPORT_DIRS = ["core", "daemon", "drivers", "http", "cli", "mcp"];

let outDir: string;
let dtsFiles: string[];

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
    dtsFiles = sourceFilesRecursive(outDir).filter((path) => path.endsWith(".d.ts"));
  }, 60_000);

  afterAll(() => {
    rmSync(outDir, { force: true, recursive: true });
    rmSync(tmpTsconfigPath, { force: true });
  });

  it("compiles both entry points and emits declarations for each", () => {
    expect(dtsFiles.some((path) => path.endsWith(join("client", "index.d.ts")))).toBe(true);
    expect(dtsFiles.some((path) => path.endsWith(join("admin", "index.d.ts")))).toBe(true);
  });

  it("never imports a core/daemon/drivers-private module from the compiled public surface", () => {
    expect(dtsFiles.length).toBeGreaterThan(0);
    // Reported where the surface first crosses into a private module, not once more for every
    // import inside the module it reached.
    const leaks = importsOf(dtsFiles, outDir).filter(({ file, normalized }) =>
      FORBIDDEN_IMPORT_DIRS.some((dir) => isUnder(normalized, dir) && !isUnder(file, dir)),
    );

    expect(leaks.map(({ file, specifier }) => `${file} imports "${specifier}"`)).toEqual([]);
  });
});

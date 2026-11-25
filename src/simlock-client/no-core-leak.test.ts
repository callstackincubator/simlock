import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importsOf, isUnder, sourceFilesRecursive } from "../test-support/imports.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const FORBIDDEN_IMPORT_DIRS = ["core", "daemon", "drivers", "http", "cli", "mcp"];

let outDir: string;
let dtsFiles: string[];

describe("public package surface (simlock/client, simlock/admin)", () => {
  let tmpTsconfigPath: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "simlock-surface-"));
    // why: Written inside the repo root (not the tmp outDir) so `"types": ["node"]` and everything
    // else in the extended `tsconfig.json` still resolves against this project's own
    // `node_modules` -- TS resolves package/type-root lookups relative to the config file's own
    // directory, not the directory of the config it extends.
    // Named per process, so two overlapping runs in one checkout never overwrite or delete
    // each other's config mid-compile.
    tmpTsconfigPath = join(repoRoot, `.simlock-surface-tsconfig.${process.pid}.json`);
    writeFileSync(
      tmpTsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { declaration: true, emitDeclarationOnly: true, outDir },
        files: ["src/client/index.ts", "src/admin/index.ts"],
        include: [],
      }),
    );
    // why: `.bin/tsc` is a shell script on POSIX and a `.cmd` shim on Windows, which `execFileSync`
    // cannot start; node running the compiler's own entry file starts the same everywhere.
    const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tscEntry, "-p", tmpTsconfigPath], {
      cwd: repoRoot,
      stdio: "pipe",
    });
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
    const leaks = importsOf(dtsFiles, outDir).filter(({ file, normalized }) =>
      FORBIDDEN_IMPORT_DIRS.some((dir) => isUnder(normalized, dir) && !isUnder(file, dir)),
    );

    expect(leaks.map(({ file, specifier }) => `${file} imports "${specifier}"`)).toEqual([]);
  });
});

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const oxlint = join(repoRoot, "node_modules", ".bin", "oxlint");
const scratch = mkdtempSync(join(tmpdir(), "simlock-lint-rules-"));
let counter = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Lints one fixture file, placed at `path` in a fresh directory laid out like the repo and given a
 * copy of the repo's `.oxlintrc.json`. Nothing is written under the real `src/`. */
function lint(path: string, source: string): { passes: boolean; rules: string[]; output: string } {
  const dir = join(scratch, String(counter++));
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  // Re-export every imported name so the fixture never trips `no-unused-vars`.
  const names = [...source.matchAll(/import (?:type )?\{ (\w+) \}/g)].map((match) => match[1]);
  writeFileSync(join(dir, path), `${source}export { ${names.join(", ")} };\n`);
  copyFileSync(join(repoRoot, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
  const result = spawnSync(oxlint, ["--format", "json", "."], { cwd: dir, encoding: "utf8" });
  const parsed = JSON.parse(result.stdout) as { diagnostics: { code: string }[] };
  return {
    passes: result.status === 0,
    rules: parsed.diagnostics.map((diagnostic) => diagnostic.code),
    output: result.stdout,
  };
}

function expectLintError(path: string, source: string): void {
  const result = lint(path, source);
  expect(result.rules, result.output).toContain("eslint(no-restricted-imports)");
  expect(result.passes).toBe(false);
}

function expectLintPass(path: string, source: string): void {
  const result = lint(path, source);
  expect(result.rules, result.output).toEqual([]);
  expect(result.passes).toBe(true);
}

describe("import rules enforced by pnpm lint", () => {
  it("fails a daemon file importing a private core file", () => {
    expectLintError("src/daemon/x.ts", `import { LeasePorts } from "../core/lease-ports.js";\n`);
  });

  it("passes a daemon file importing core's index", () => {
    expectLintPass("src/daemon/x.ts", `import { Registry } from "../core/index.js";\n`);
  });

  it("fails a file two levels deep importing a file inside core's component directory", () => {
    expectLintError(
      "src/http/deep/x.ts",
      `import { limits } from "../../core/capacity/limits.js";\n`,
    );
  });

  it("fails a driver importing core's private driver file", () => {
    expectLintError(
      "src/drivers/ios/x.ts",
      `import type { Driver } from "../../core/driver.js";\n`,
    );
  });

  it("fails a file importing a compiled private core file", () => {
    expectLintError("e2e/fake-driver/x.ts", `import { x } from "../../dist/core/driver.js";\n`);
  });

  it("passes a file importing core's compiled index", () => {
    expectLintPass("e2e/fake-driver/x.ts", `import { x } from "../../dist/core/index.js";\n`);
  });

  it("fails a file importing a private gateway file", () => {
    expectLintError("src/cli/x.ts", `import { x } from "../gateway/queue.js";\n`);
  });

  it("fails a daemon file importing core's testing helpers", () => {
    expectLintError("src/daemon/x.ts", `import { x } from "../core/testing.js";\n`);
  });

  it("passes core's testing helpers in a daemon test file and in an http test helper", () => {
    expectLintPass("src/daemon/x.test.ts", `import { x } from "../core/testing.js";\n`);
    expectLintPass("src/http/test-fakes.ts", `import { x } from "../core/testing.js";\n`);
  });

  it("passes a core test file importing node:fs/promises, and fails the same import in a core file", () => {
    expectLintPass("src/core/x.test.ts", `import { readFile } from "node:fs/promises";\n`);
    expectLintError("src/core/x.ts", `import { readFile } from "node:fs/promises";\n`);
  });

  it("fails a core file importing fs, child_process or a driver", () => {
    expectLintError("src/core/x.ts", `import { x } from "fs";\n`);
    expectLintError("src/core/x.ts", `import { x } from "node:child_process";\n`);
    expectLintError("src/core/x.ts", `import { x } from "child_process";\n`);
    expectLintError("src/core/x.ts", `import { x } from "../drivers/ios/index.js";\n`);
  });

  it("fails a core file importing inside capacity, and passes capacity's index", () => {
    expectLintError("src/core/x.ts", `import { x } from "./capacity/limits.js";\n`);
    expectLintPass("src/core/x.ts", `import { x } from "./capacity/index.js";\n`);
  });

  it("passes a file inside capacity importing its sibling", () => {
    expectLintPass("src/core/capacity/x.ts", `import { x } from "./limits.js";\n`);
  });

  it("fails a gateway file importing Registry from core's index", () => {
    expectLintError("src/gateway/x.ts", `import { Registry } from "../core/index.js";\n`);
  });

  it("passes a gateway file importing a name it is allowed from core's index", () => {
    expectLintPass("src/gateway/x.ts", `import { WaitQueue } from "../core/index.js";\n`);
  });

  it("fails a gateway file importing from drivers, http, cli or mcp", () => {
    for (const dir of ["drivers", "http", "cli", "mcp"]) {
      expectLintError("src/gateway/x.ts", `import { x } from "../${dir}/index.js";\n`);
    }
  });

  it("fails a gateway file importing the daemon server, and passes the dispatch contract", () => {
    expectLintError("src/gateway/x.ts", `import { x } from "../daemon/server.js";\n`);
    expectLintPass("src/gateway/x.ts", `import { x } from "../daemon/dispatch.js";\n`);
  });

  it("fails a nested gateway file importing a private core file", () => {
    expectLintError("src/gateway/routing/x.ts", `import { x } from "../../core/registry.js";\n`);
  });

  it("fails a daemon file importing the gateway, and passes the same import in main.ts", () => {
    expectLintError("src/daemon/x.ts", `import { x } from "../gateway/index.js";\n`);
    expectLintPass("src/daemon/main.ts", `import { x } from "../gateway/index.js";\n`);
  });

  it("fails a contract file importing anything outside the contract", () => {
    expectLintError("src/contract/x.ts", `import { x } from "../core/index.js";\n`);
    expectLintError("src/contract/x.ts", `import { x } from "../bus/index.js";\n`);
  });

  it("passes a contract file importing a package and its own siblings", () => {
    expectLintPass("src/contract/x.ts", `import { z } from "zod";\nimport { y } from "./y.js";\n`);
  });
});

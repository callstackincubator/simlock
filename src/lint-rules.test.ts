import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const oxlint = join(repoRoot, "node_modules", ".bin", "oxlint");
const depcruise = join(repoRoot, "node_modules", ".bin", "depcruise");
const scratch = mkdtempSync(join(tmpdir(), "simlock-lint-rules-"));
let counter = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Lints one fixture file, placed at `path` in a fresh directory laid out like the repo and given a
 * copy of the repo's `.oxlintrc.json`. Nothing is written under the real `src/`. */
function lint(path: string, source: string): { passes: boolean; rules: string[]; output: string } {
  const dir = join(scratch, `oxlint-${counter++}`);
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

describe("import-name rules enforced by oxlint", () => {
  it("fails a gateway file importing Registry from core's index", () => {
    expectLintError("src/gateway/x.ts", `import { Registry } from "../core/index.js";\n`);
  });

  it("passes a gateway file importing a name it is allowed from core's index", () => {
    expectLintPass("src/gateway/x.ts", `import { LeaseRecord } from "../core/index.js";\n`);
  });

  it("fails a gateway file importing createLeasing from leasing's index, and passes LeaseRequestBook", () => {
    expectLintError("src/gateway/x.ts", `import { createLeasing } from "../leasing/index.js";\n`);
    expectLintPass("src/gateway/x.ts", `import { LeaseRequestBook } from "../leasing/index.js";\n`);
  });

  it("fails a gateway file importing a leasing name from core's index, and a leasing name outside its allow-list", () => {
    expectLintError("src/gateway/x.ts", `import { WaitQueue } from "../core/index.js";\n`);
    expectLintError(
      "src/gateway/x.ts",
      `import { LeaseHealthMonitor } from "../leasing/index.js";\n`,
    );
    expectLintPass("src/gateway/x.ts", `import { WaitQueue } from "../leasing/index.js";\n`);
  });

  it("passes a gateway test file importing a name outside the allow-list", () => {
    expectLintPass("src/gateway/x.test.ts", `import { Registry } from "../core/index.js";\n`);
  });
});

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string };
}

function cruise(dir: string, args: readonly string[]): Violation[] {
  const result = spawnSync(depcruise, [...args, "--output-type", "json"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(result.stdout) as { summary: { violations: Violation[] } };
  return parsed.summary.violations;
}

function componentsOf(dir: string): string[] {
  const entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
  const here = entries.some((entry) => entry.isFile() && entry.name === "index.ts") ? [dir] : [];
  return here.concat(
    entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => componentsOf(`${dir}/${entry.name}`)),
  );
}

type Verdict = "fails" | "passes";
type Expectation = readonly [Verdict, path: string, specifier: string, unbuilt?: "unbuilt"];

// why: one dependency-cruiser run serves every case, so a fixture named x.ts gets its case's number to keep cases apart; main.ts and testing.ts collect every case's imports.
const pathCases: readonly (readonly [string, readonly Expectation[]])[] = [
  [
    "fails a daemon file importing a private core file, and passes core's index",
    [
      ["fails", "src/daemon/x.ts", "../core/lease-ports.js"],
      ["passes", "src/daemon/x.ts", "../core/index.js"],
    ],
  ],
  [
    "fails a file two levels deep importing a file inside core's component directory",
    [["fails", "src/http/deep/x.ts", "../../core/capacity/limits.js"]],
  ],
  [
    "fails a driver importing core's private driver file",
    [["fails", "src/drivers/ios/x.ts", "../../core/driver.js"]],
  ],
  [
    "fails a file importing a compiled private core file, and passes core's compiled index",
    [
      ["fails", "e2e/fake-driver/x.ts", "../../dist/core/driver.js"],
      ["passes", "e2e/fake-driver/x.ts", "../../dist/core/index.js"],
    ],
  ],
  [
    "fails a file importing a compiled private core file while dist/ is not built",
    [["fails", "e2e/fake-driver/x.ts", "../../dist/core/registry.js", "unbuilt"]],
  ],
  [
    "fails a file importing a private gateway file",
    [["fails", "src/cli/x.ts", "../gateway/queue.js"]],
  ],
  [
    "guards a component that no config names, from the moment it has an index",
    [
      ["fails", "src/cli/x.ts", "../bus/event-file.js"],
      ["passes", "src/cli/x.ts", "../bus/index.js"],
    ],
  ],
  [
    "fails a daemon file importing core's testing helpers",
    [["fails", "src/daemon/x.ts", "../core/testing.js"]],
  ],
  [
    "passes core's testing helpers in a daemon test file and in an http test helper",
    [
      ["passes", "src/daemon/x.test.ts", "../core/testing.js"],
      ["passes", "src/http/test-fakes.ts", "../core/testing.js"],
    ],
  ],
  [
    "passes a core test file importing node:fs/promises, and fails the same import in a core file",
    [
      ["passes", "src/core/x.test.ts", "node:fs/promises"],
      ["fails", "src/core/x.ts", "node:fs/promises"],
    ],
  ],
  [
    "fails a core file importing fs, child_process or a driver",
    [
      ["fails", "src/core/x.ts", "fs"],
      ["fails", "src/core/x.ts", "node:child_process"],
      ["fails", "src/core/x.ts", "child_process"],
      ["fails", "src/core/x.ts", "../drivers/ios/index.js"],
    ],
  ],
  [
    "fails a core file importing inside capacity, and passes capacity's index",
    [
      ["fails", "src/core/x.ts", "./capacity/limits.js"],
      ["passes", "src/core/x.ts", "./capacity/index.js"],
    ],
  ],
  [
    "fails a file importing a private driver file, and passes the driver's index",
    [
      ["fails", "src/http/x.ts", "../drivers/ios/prerequisites.js"],
      ["fails", "src/http/x.ts", "../drivers/android/prerequisites.js"],
      ["fails", "src/daemon/main.ts", "../drivers/ios/prerequisites.js"],
      ["fails", "src/daemon/x.ts", "../drivers/android/prerequisites.js"],
      ["passes", "src/daemon/main.ts", "../drivers/ios/index.js"],
    ],
  ],
  [
    "fails a core file importing a private gateway file",
    [["fails", "src/core/x.ts", "../gateway/queue.js"]],
  ],
  [
    "fails a test file importing a private file, and passes the component's testing file",
    [
      ["fails", "src/http/x.test.ts", "../core/lease-ports.js"],
      ["fails", "src/http/x.test.ts", "../gateway/queue.js"],
      ["fails", "src/http/x.test.ts", "../drivers/ios/prerequisites.js"],
      ["fails", "src/http/x.test.ts", "../drivers/android/prerequisites.js"],
      ["fails", "src/core/x.test.ts", "./capacity/limits.js"],
      ["passes", "src/core/x.test.ts", "./capacity/testing.js"],
    ],
  ],
  [
    "passes a file inside capacity importing its sibling",
    [["passes", "src/core/capacity/x.ts", "./limits.js"]],
  ],
  [
    "fails a gateway file importing from drivers, http, cli or mcp",
    [
      ["fails", "src/gateway/x.ts", "../drivers/ios/index.js"],
      ["fails", "src/gateway/x.ts", "../http/index.js"],
      ["fails", "src/gateway/x.ts", "../cli/index.js"],
      ["fails", "src/gateway/x.ts", "../mcp/index.js"],
    ],
  ],
  [
    "fails a gateway file importing the daemon server, and passes the dispatch contract",
    [
      ["fails", "src/gateway/x.ts", "../daemon/server.js"],
      ["passes", "src/gateway/x.ts", "../daemon/dispatch.js"],
    ],
  ],
  [
    "fails a nested gateway file importing a private core file",
    [["fails", "src/gateway/routing/x.ts", "../../core/registry.js"]],
  ],
  [
    "fails a daemon file importing the gateway, and passes the same import in main.ts",
    [
      ["fails", "src/daemon/x.ts", "../gateway/index.js"],
      ["passes", "src/daemon/main.ts", "../gateway/index.js"],
    ],
  ],
  [
    "fails a contract file importing anything outside the contract",
    [
      ["fails", "src/contract/x.ts", "../core/index.js"],
      ["fails", "src/contract/x.ts", "../bus/index.js"],
      ["fails", "src/contract/x.ts", "./sub/../../core/index.js"],
      ["fails", "src/contract/sub/x.ts", "./../../bus/index.js"],
      ["fails", "src/contract/x.ts", "/abs/core/index.js", "unbuilt"],
    ],
  ],
  [
    "passes a contract file importing a package and its own siblings",
    [
      ["passes", "src/contract/x.ts", "zod", "unbuilt"],
      ["passes", "src/contract/x.ts", "./y.js"],
    ],
  ],
  [
    "fails a file inside drivers importing past the ios or android index from outside it, and passes the index",
    [
      ["fails", "src/drivers/installer-process.ts", "./ios/prerequisites.js"],
      ["fails", "src/drivers/android/x.ts", "../ios/simctl.js"],
      ["fails", "src/drivers/x.ts", "./android/prerequisites.js"],
      ["fails", "src/drivers/ios/x.ts", "../android/adb.js"],
      ["passes", "src/drivers/x.ts", "./ios/index.js"],
      ["passes", "src/drivers/android/x.ts", "../ios/index.js"],
    ],
  ],
  [
    "passes a file inside a driver importing its sibling",
    [
      ["passes", "src/drivers/ios/x.ts", "./simctl.js"],
      ["passes", "src/drivers/android/sub/x.ts", "../adb.js"],
    ],
  ],
  [
    "fails a test file outside core importing capacity's testing file or index through core",
    [
      ["fails", "src/http/x.test.ts", "../core/capacity/testing.js"],
      ["fails", "src/http/x.test.ts", "../core/capacity/index.js"],
      ["fails", "src/http/test-fakes.ts", "../core/capacity/testing.js"],
    ],
  ],
  [
    "fails a testing.ts file breaking its module's direction rule",
    [
      ["fails", "src/core/testing.ts", "node:fs"],
      ["fails", "src/core/testing.ts", "../drivers/ios/index.js"],
      ["fails", "src/core/capacity/testing.ts", "node:fs"],
    ],
  ],
  [
    "fails a production file importing a testing.js or test-*.js file",
    [
      ["fails", "src/core/x.ts", "./testing.js"],
      ["fails", "src/core/x.ts", "./test-wiring.js"],
      ["fails", "src/core/x.ts", "./capacity/testing.js"],
      ["fails", "src/core/capacity/x.ts", "./testing.js"],
      ["fails", "src/gateway/x.ts", "./testing.js"],
      ["fails", "src/daemon/x.ts", "./test-helpers.js"],
      ["fails", "src/daemon/main.ts", "./testing.js"],
      ["fails", "src/http/x.ts", "./test-fakes.js"],
      ["fails", "src/contract/x.ts", "./testing.js"],
    ],
  ],
  [
    "passes a test file importing its own module's testing.js or test-*.js file",
    [
      ["passes", "src/core/x.test.ts", "./testing.js"],
      ["passes", "src/http/x.test.ts", "./test-fakes.js"],
    ],
  ],
  [
    "fails a core file importing leasing's index, and passes leasing's testing file in a core test",
    [
      ["fails", "src/core/x.ts", "../leasing/index.js"],
      ["passes", "src/core/x.test.ts", "../leasing/testing.js"],
    ],
  ],
  [
    "fails a core test importing a private leasing file",
    [["fails", "src/core/x.test.ts", "../leasing/wait-queue.js"]],
  ],
  [
    "fails a daemon file importing a private leasing file, and passes leasing's index",
    [
      ["fails", "src/daemon/x.ts", "../leasing/wait-queue.js"],
      ["passes", "src/daemon/x.ts", "../leasing/index.js"],
    ],
  ],
  [
    "fails a leasing file importing node:fs, child_process or a driver",
    [
      ["fails", "src/leasing/x.ts", "node:fs"],
      ["fails", "src/leasing/x.ts", "child_process"],
      ["fails", "src/leasing/x.ts", "../drivers/ios/index.js"],
    ],
  ],
  [
    "passes leasing's testing file in a daemon test file, and fails the same import in a daemon file",
    [
      ["passes", "src/daemon/x.test.ts", "../leasing/testing.js"],
      ["fails", "src/daemon/x.ts", "../leasing/testing.js"],
    ],
  ],
  [
    "fails a leasing file importing a private core file, and passes core's index; a leasing test may import core's testing file",
    [
      ["fails", "src/leasing/x.ts", "../core/registry.js"],
      ["fails", "src/leasing/x.ts", "../core/testing.js"],
      ["passes", "src/leasing/x.ts", "../core/index.js"],
      ["passes", "src/leasing/x.test.ts", "../core/testing.js"],
      ["fails", "src/leasing/x.test.ts", "../core/registry.js"],
    ],
  ],
  [
    "fails leasing's testing file breaking leasing's direction rule, and core's testing file importing leasing",
    [
      ["fails", "src/leasing/testing.ts", "node:fs"],
      ["fails", "src/core/testing.ts", "../leasing/testing.js"],
    ],
  ],
  [
    "passes the composition root importing leasing's index",
    [
      ["passes", "src/daemon/main.ts", "../leasing/index.js"],
      ["fails", "src/daemon/main.ts", "../leasing/wait-queue.js"],
    ],
  ],
  [
    "fails a file under core, leasing, drivers/ios or drivers/android importing agent-device's index",
    [
      ["fails", "src/core/x.ts", "../agent-device/index.js"],
      ["fails", "src/leasing/x.ts", "../agent-device/index.js"],
      ["fails", "src/drivers/ios/x.ts", "../../agent-device/index.js"],
      ["fails", "src/drivers/android/x.ts", "../../agent-device/index.js"],
    ],
  ],
  [
    "fails a daemon file importing agent-device's supervisor file, and passes its index",
    [
      ["fails", "src/daemon/x.ts", "../agent-device/host/agent-device-supervisor.js"],
      ["passes", "src/daemon/x.ts", "../agent-device/index.js"],
    ],
  ],
  [
    "passes agent-device's testing file in a daemon test file and in agent-device's own test, and fails it in a daemon file",
    [
      ["passes", "src/daemon/x.test.ts", "../agent-device/testing.js"],
      ["passes", "src/agent-device/host/x.test.ts", "../testing.js"],
      ["fails", "src/daemon/x.ts", "../agent-device/testing.js"],
    ],
  ],
  ...[
    "src/agent-device/host/x.ts",
    "src/agent-device/shared/x.ts",
    "src/agent-device/index.ts",
  ].map(
    (path) =>
      [
        `fails ${path} importing fs, node:fs, node:fs/promises, child_process or node:child_process`,
        ["fs", "node:fs", "node:fs/promises", "child_process", "node:child_process"].map(
          (module) => ["fails", path, module] as const,
        ),
      ] as const,
  ),
  [
    "fails a host-load file importing node:fs/promises, child_process or core",
    [
      ["fails", "src/host-load/x.ts", "node:fs/promises"],
      ["fails", "src/host-load/x.ts", "fs"],
      ["fails", "src/host-load/x.ts", "child_process"],
      ["fails", "src/host-load/x.ts", "node:child_process"],
      ["fails", "src/host-load/x.ts", "../core/index.js"],
      ["fails", "src/host-load/x.ts", "../leasing/index.js"],
      ["fails", "src/host-load/x.ts", "../gateway/index.js"],
      ["fails", "src/host-load/x.ts", "../contract/index.js"],
      ["passes", "src/host-load/x.ts", "../ports/index.js"],
    ],
  ],
  [
    "fails a core, leasing, driver, gateway or contract file importing host-load",
    [
      ["fails", "src/core/x.ts", "../host-load/index.js"],
      ["fails", "src/leasing/x.ts", "../host-load/index.js"],
      ["fails", "src/drivers/ios/x.ts", "../../host-load/index.js"],
      ["fails", "src/drivers/android/x.ts", "../../host-load/index.js"],
      ["fails", "src/gateway/x.ts", "../host-load/index.js"],
      ["fails", "src/contract/x.ts", "../host-load/index.js"],
    ],
  ],
  [
    "passes the composition root importing host-load's index, and fails its private file",
    [
      ["passes", "src/daemon/main.ts", "../host-load/index.js"],
      ["fails", "src/daemon/main.ts", "../host-load/sampler.js"],
    ],
  ],
  [
    "fails a modules file importing anything outside ports, contract and core, and passes those three",
    [
      ["fails", "src/modules/x.ts", "../leasing/index.js"],
      ["fails", "src/modules/x.ts", "../gateway/index.js"],
      ["fails", "src/modules/x.ts", "../agent-device/index.js"],
      ["fails", "src/modules/x.ts", "../bus/index.js"],
      ["passes", "src/modules/x.ts", "../ports/index.js"],
      ["passes", "src/modules/x.ts", "../contract/index.js"],
      ["passes", "src/modules/x.ts", "../core/index.js"],
    ],
  ],
  [
    "fails a core, leasing, driver, gateway or contract file importing modules or module-registry",
    [
      ["fails", "src/core/x.ts", "../modules/index.js"],
      ["fails", "src/core/x.ts", "../module-registry/index.js"],
      ["fails", "src/leasing/x.ts", "../modules/index.js"],
      ["fails", "src/leasing/x.ts", "../module-registry/index.js"],
      ["fails", "src/drivers/ios/x.ts", "../../modules/index.js"],
      ["fails", "src/drivers/android/x.ts", "../../module-registry/index.js"],
      ["fails", "src/gateway/x.ts", "../modules/index.js"],
      ["fails", "src/gateway/x.ts", "../module-registry/index.js"],
      ["fails", "src/contract/x.ts", "../modules/index.js"],
      ["fails", "src/contract/x.ts", "../module-registry/index.js"],
    ],
  ],
  [
    "passes the composition root importing modules' and module-registry's index",
    [
      ["passes", "src/daemon/main.ts", "../modules/index.js"],
      ["passes", "src/daemon/main.ts", "../module-registry/index.js"],
      ["fails", "src/daemon/main.ts", "../modules/host.js"],
    ],
  ],
  [
    "passes an agent-device test file importing node:fs",
    [["passes", "src/agent-device/host/x.test.ts", "node:fs"]],
  ],
];

function fixturePath(path: string, caseIndex: number): string {
  return path.replace(/\/x(\.test)?\.ts$/, `/x${caseIndex}$1.ts`);
}

function targetOf(from: string, specifier: string, unbuilt: boolean): string {
  if (unbuilt || !specifier.startsWith(".")) return specifier.replace(/^node:/, "");
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  return joined.startsWith("dist/") ? joined : joined.replace(/\.js$/, ".ts");
}

function touch(dir: string, path: string): void {
  if (existsSync(join(dir, path))) return;
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), "export {};\n");
}

describe("import-path rules enforced by dependency-cruiser", () => {
  let violations: Violation[] = [];

  beforeAll(() => {
    const dir = join(scratch, "depcruise");
    const imports = new Map<string, string[]>();
    for (const component of componentsOf("src")) touch(dir, `${component}/index.ts`);
    pathCases.forEach(([, expectations], caseIndex) => {
      for (const [, path, specifier, unbuilt] of expectations) {
        const from = fixturePath(path, caseIndex);
        imports.set(from, [...(imports.get(from) ?? []), `import "${specifier}";\n`]);
        if (unbuilt === undefined && specifier.startsWith(".")) {
          touch(dir, targetOf(from, specifier, false));
        }
      }
    });
    for (const [from, lines] of imports) {
      mkdirSync(dirname(join(dir, from)), { recursive: true });
      writeFileSync(join(dir, from), `${lines.join("")}export {};\n`);
    }
    copyFileSync(join(repoRoot, ".dependency-cruiser.mjs"), join(dir, ".dependency-cruiser.mjs"));
    copyFileSync(join(repoRoot, "tsconfig.json"), join(dir, "tsconfig.json"));
    violations = cruise(dir, ["src", "e2e", "dist"]);
  });

  it.each(
    pathCases.map(([title, expectations], caseIndex) => ({ title, expectations, caseIndex })),
  )("$title", ({ expectations, caseIndex }) => {
    for (const [verdict, path, specifier, unbuilt] of expectations) {
      const from = fixturePath(path, caseIndex);
      const to = targetOf(from, specifier, unbuilt !== undefined);
      const found = violations.filter((v) => v.from === from && v.to === to);
      if (verdict === "fails") expect(found, `${from} -> ${specifier}`).not.toEqual([]);
      else expect(found, `${from} -> ${specifier}`).toEqual([]);
    }
  });
});

describe("a module's definition.ts, read by the registry without loading the module", () => {
  const world: Record<string, string> = {
    "src/heavy/definition.ts": 'import { heavy } from "./impl.js";\nexport const d = heavy;\n',
    "src/heavy/impl.ts": "export const heavy = 1;\n",
    "src/heavy/index.ts": "export {};\n",
    "src/light/definition.ts":
      'import type { Light } from "./impl.js";\nexport type D = Light;\nexport const load = () => import("./impl.js");\n',
    "src/light/impl.ts": "export type Light = number;\n",
    "src/light/index.ts": "export {};\n",
    "src/module-registry/index.ts":
      'import "../heavy/definition.js";\nimport "../light/definition.js";\nexport {};\n',
    "src/module-registry/other.ts": 'import "../light/impl.js";\nexport {};\n',
  };

  function worldViolations(): Violation[] {
    const dir = join(scratch, `definitions-${counter++}`);
    for (const [path, source] of Object.entries(world)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    copyFileSync(join(repoRoot, ".dependency-cruiser.mjs"), join(dir, ".dependency-cruiser.mjs"));
    copyFileSync(join(repoRoot, "tsconfig.json"), join(dir, "tsconfig.json"));
    return cruise(dir, ["src"]);
  }

  it("dependency-cruiser fails a definition.ts that imports a value from its own module, and passes a type-only and a dynamic-import one", () => {
    const found = worldViolations();

    expect(
      found.filter((v) => v.from === "src/heavy/definition.ts").map((v) => v.rule.name),
    ).toEqual(["definition-is-light"]);
    expect(found.filter((v) => v.from === "src/light/definition.ts")).toEqual([]);
  });

  it("dependency-cruiser lets the registry import a module's definition.ts, and no other file past its index", () => {
    const found = worldViolations();

    expect(found.filter((v) => v.from === "src/module-registry/index.ts")).toEqual([]);
    expect(found.filter((v) => v.from === "src/module-registry/other.ts")).not.toEqual([]);
  });
});

describe("the cycle check between components", () => {
  function cycleWorld(files: Record<string, string>): Violation[] {
    const dir = join(scratch, `cycles-${counter++}`);
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    for (const config of [".dependency-cruiser.mjs", ".dependency-cruiser.cycles.mjs"]) {
      copyFileSync(join(repoRoot, config), join(dir, config));
    }
    copyFileSync(join(repoRoot, "tsconfig.json"), join(dir, "tsconfig.json"));
    return cruise(dir, ["src", "--config", ".dependency-cruiser.cycles.mjs"]);
  }

  it("fails two components that import each other through files that form no file-level cycle", () => {
    const found = cycleWorld({
      "src/a/index.ts": 'import "../b/index.js";\nexport {};\n',
      "src/a/leaf.ts": "export {};\n",
      "src/b/index.ts": 'import "../a/leaf.js";\nexport {};\n',
    });
    expect(found.map((v) => v.rule.name)).toContain("no-cycle-between-components");
  });

  it("passes a cycle that runs only through test files and testing.ts", () => {
    const found = cycleWorld({
      "src/a/index.ts": "export {};\n",
      "src/a/x.test.ts": 'import "../b/testing.js";\nexport {};\n',
      "src/b/index.ts": "export {};\n",
      "src/b/testing.ts": 'import "../a/index.js";\nexport {};\n',
    });
    expect(found).toEqual([]);
  });
});

describe("the repo's known violations", () => {
  const read = (file: string): Violation[] =>
    JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as Violation[];
  const key = (v: Violation): string => `${v.rule.name} ${v.from} -> ${v.to}`;

  it("lists every cycle between components the repo has, and no cycle it no longer has", () => {
    const found = cruise(repoRoot, ["src", "--config", ".dependency-cruiser.cycles.mjs"]);
    expect(found.map(key).sort()).toEqual(
      read(".dependency-cruiser-known-cycles.json").map(key).sort(),
    );
  });

  it("never grows past what the repo had when dependency-cruiser was adopted", () => {
    expect(read(".dependency-cruiser-known-violations.json").length).toBeLessThanOrEqual(24);
    expect(read(".dependency-cruiser-known-cycles.json").length).toBeLessThanOrEqual(6);
  });
});

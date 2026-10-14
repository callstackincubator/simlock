// why: a component is any directory under src/ with an index.ts, found when the config loads, so a new one is guarded from its first commit (ADR 0027).
import { readdirSync } from "node:fs";

function findComponents(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const here = entries.some((entry) => entry.isFile() && entry.name === "index.ts") ? [dir] : [];
  return here.concat(
    entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => findComponents(`${dir}/${entry.name}`)),
  );
}

const escape = (path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const testFile = "(\\.test\\.tsx?|/test-[^/]+\\.tsx?)$";
const fsOrProcess = "^(node:)?(fs|fs/promises|child_process)$";

// why: e2e imports the compiled package from dist/, which mirrors src/, so each component's rule covers its compiled copy too.
const components = findComponents("src")
  .filter((dir) => dir !== "src")
  .flatMap((dir) => [dir, `dist${dir.slice("src".length)}`]);

const pastIndex = components.map((component) => ({
  name: "past-index",
  comment: `${component} is entered through its index`,
  severity: "error",
  from: { pathNot: `^${escape(component)}/` },
  to: {
    path: `^${escape(component)}/`,
    pathNot: `^${escape(component)}/(index|testing)\\.(ts|js)$`,
  },
}));

const direction = (name, comment, from, to) => ({
  name,
  comment,
  severity: "error",
  from: { path: from, pathNot: testFile },
  to,
});

export default {
  forbidden: [
    ...pastIndex,
    {
      name: "past-index-unbuilt",
      comment:
        "the compiled package is entered through a component's index.js, whether or not dist/ is built",
      severity: "error",
      from: {},
      to: {
        couldNotResolve: true,
        path: "(^|/)dist/",
        pathNot: "(^|/)dist/[^/]+/index\\.js$",
      },
    },
    {
      name: "testing-only-in-tests",
      comment: "only a *.test.ts file or a test-*.ts helper imports a testing.ts or test-*.ts file",
      severity: "error",
      from: { pathNot: testFile },
      to: { path: "(^|/)(testing|test-[^/]+)\\.tsx?$" },
    },
    direction(
      "core-not-leasing",
      "core never imports leasing: where it needs something from leasing it declares a port, and the composition root connects it",
      "^src/core/",
      { path: "^src/leasing/" },
    ),
    direction(
      "core-not-drivers",
      "platform behaviour reaches the core and leasing only through the Driver interface",
      "^src/(core|leasing)/",
      { path: "^src/drivers/" },
    ),
    direction(
      "no-fs-or-process",
      "core, leasing, agent-device and host-load reach the filesystem and processes only through injected ports",
      "^src/(core|leasing|agent-device|host-load)/",
      { dependencyTypes: ["core"], path: fsOrProcess },
    ),
    direction(
      "not-agent-device",
      "the core, leasing and the drivers import nothing from the agent-device edge",
      "^src/(core|leasing|drivers)/",
      { path: "^src/agent-device/" },
    ),
    direction(
      "host-load-imports-ports-only",
      "host-load reads the machine through the HostLoadProbe port and imports no other component",
      "^src/host-load/",
      { path: "^src/(core|leasing|gateway|drivers|contract|http|cli|mcp|daemon)/" },
    ),
    direction(
      "not-host-load",
      "core, leasing, the drivers, the gateway and the contract import nothing from host-load",
      "^src/(core|leasing|drivers|gateway|contract)/",
      { path: "^src/host-load/" },
    ),
    direction(
      "gateway-not-edges",
      "the gateway imports no driver, HTTP, CLI or MCP module",
      "^src/gateway/",
      { path: "^src/(drivers|http|cli|mcp)/" },
    ),
    direction(
      "gateway-only-dispatch",
      "the gateway imports only the daemon's dispatch contract",
      "^src/gateway/",
      { path: "^src/daemon/", pathNot: "^src/daemon/dispatch\\.ts$" },
    ),
    direction(
      "only-main-knows-gateway",
      "only the composition root, main.ts, knows a gateway exists",
      "^src/daemon/(?!main\\.ts$)",
      { path: "^src/gateway/" },
    ),
    direction(
      "contract-imports-nothing",
      "the contract imports nothing outside src/contract/",
      "^src/contract/",
      { path: "^(src|dist|e2e|ui)/", pathNot: "^src/contract/" },
    ),
    direction(
      "contract-imports-nothing-unresolved",
      "the contract imports nothing outside src/contract/",
      "^src/contract/",
      { couldNotResolve: true, path: "^[./]" },
    ),
  ],
  options: {
    doNotFollow: { path: ["node_modules", "^dist/"] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { extensions: [".ts", ".tsx", ".js", ".mjs"] },
  },
};

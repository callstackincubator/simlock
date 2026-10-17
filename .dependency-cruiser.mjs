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
const linkTestFile = "(\\.test\\.tsx?|/test-[^/]+\\.tsx?|/testing\\.ts)$";
// why: the console layers below the screens are plain TypeScript, so a test drives them without a browser.
const uiLibrary = "(^|node_modules/)(react|react-dom|recharts|@tanstack/[^/]+)(/|$)";
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
    pathNot: `^${escape(component)}/(index|testing|definition)\\.(ts|js)$`,
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
    {
      name: "link-is-portable",
      comment:
        "the link uses no Node module and no package, so it runs in a browser or React Native and can move to its own package",
      severity: "error",
      from: { path: "^src/link/", pathNot: linkTestFile },
      to: {
        dependencyTypes: [
          "core",
          "npm",
          "npm-dev",
          "npm-optional",
          "npm-peer",
          "npm-bundled",
          "npm-no-pkg",
          "npm-unknown",
        ],
      },
    },
    {
      name: "link-imports-port-types-only",
      comment:
        "the link imports only the types of src/ports/, because a value from the ports barrel pulls in every Node adapter",
      severity: "error",
      from: { path: "^src/link/", pathNot: linkTestFile },
      to: { path: "^src/ports/", dependencyTypesNot: ["type-only"] },
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
      "core, leasing, agent-device, host-load and stream reach the filesystem and processes only through injected ports",
      "^src/(core|leasing|agent-device|host-load|stream)/",
      { dependencyTypes: ["core"], path: fsOrProcess },
    ),
    direction(
      "not-agent-device",
      "the core, leasing and the drivers import nothing from the agent-device edge",
      "^src/(core|leasing|drivers)/",
      { path: "^src/agent-device/" },
    ),
    direction(
      "not-stream",
      "core, leasing, the drivers, the gateway and the contract import nothing from the stream module",
      "^src/(core|leasing|drivers|gateway|contract)/",
      { path: "^src/stream/" },
    ),
    direction(
      "stream-not-edges",
      "the stream module is a module the host loads: it imports no frontend, gateway, driver or leasing",
      "^src/stream/",
      { path: "^src/(http|gateway|drivers|daemon|cli|mcp|leasing)/" },
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
    {
      name: "definition-is-light",
      comment:
        "a module's definition.ts imports its own module only for types or by dynamic import, so reading the registry loads no module code",
      severity: "error",
      from: { path: "^src/([^/]+)/definition\\.ts$" },
      to: {
        dependencyTypesNot: ["type-only", "dynamic-import"],
        path: "^src/$1/",
        pathNot: "^src/$1/definition\\.ts$",
      },
    },
    {
      name: "modules-imports-little",
      comment: "src/modules imports only ports, contract and core, plus the bus for its types",
      severity: "error",
      from: { path: "^src/modules/", pathNot: linkTestFile },
      to: { path: "^src/", pathNot: "^src/(modules|ports|contract|core|bus)/" },
    },
    {
      name: "modules-imports-bus-types-only",
      comment: "src/modules imports the bus for its types only",
      severity: "error",
      from: { path: "^src/modules/", pathNot: linkTestFile },
      to: { path: "^src/bus/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "main-loads-modules-lazily",
      comment:
        "main.ts imports nothing from src/agent-device, of any type: a module reaches a daemon only through the module host",
      severity: "error",
      from: { path: "^src/daemon/main\\.ts$" },
      to: { path: "^src/agent-device/" },
    },
    direction(
      "not-modules",
      "core, leasing, the drivers, the gateway and the contract import nothing from the optional-module host or its registry",
      "^src/(core|leasing|drivers|gateway|contract)/",
      { path: "^src/(modules|module-registry)/" },
    ),
    direction(
      "ui-ds-stands-alone",
      "the console's design system imports nothing else of the console",
      "^ui/src/ds/",
      { path: "^ui/src/(app|screens|state|data|model)/" },
    ),
    direction(
      "ui-model-is-pure",
      "the console's business rules import no other layer and no UI library",
      "^ui/src/model/",
      { path: `^ui/src/(app|screens|state|data|ds)/|${uiLibrary}` },
    ),
    direction(
      "ui-data-is-below-the-ui",
      "the console's network and storage layer imports no state, screen, design system or UI library",
      "^ui/src/data/",
      { path: `^ui/src/(app|screens|state|ds)/|${uiLibrary}` },
    ),
    direction(
      "ui-state-feeds-screens",
      "the console's state layer imports no screen, and from the design system only the types it fills",
      "^ui/src/state/",
      { path: "^ui/src/(app|screens)/" },
    ),
    direction(
      "ui-state-ds-types-only",
      "the console's state layer imports no screen, and from the design system only the types it fills",
      "^ui/src/state/",
      { path: "^ui/src/ds/", dependencyTypesNot: ["type-only"] },
    ),
    direction(
      "ui-screens-present-only",
      "a console screen reaches data only through the state layer: no network, storage or business rule of its own",
      "^ui/src/screens/",
      { path: "^ui/src/(app|data|model)/" },
    ),
    direction(
      "cli-router-imports-no-component-values",
      "the CLI's router answers --help and a usage error before any component loads: these files reach another component only for types, by dynamic import, or statically for agent-identity alone, so the fast paths load no component code",
      "^src/cli/(main|index|tree|errors|types|usage-error|environment|stdio|log-file|args|connect)\\.ts$",
      {
        // why: every component but agent-identity, the one AGENTS.md carves out as the cheap
        // static import, plus the command modules: a static edge to one of those from the
        // router is the same eager load this rule exists to keep out
        path: "^src/((?!agent-identity/|cli/)[a-z0-9-]+/)|^src/cli/commands/",
        dependencyTypesNot: ["type-only", "dynamic-import"],
      },
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

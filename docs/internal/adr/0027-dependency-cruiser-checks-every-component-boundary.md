# 0027. dependency-cruiser checks every component's boundary and the module graph

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** none; the change that adopted architecture rules 18–21
  carries it.
- **Supersedes:** the path rules of
  [ADR 0018](0018-leasing-is-one-module-and-every-module-is-entered-through-its-index.md)
  §4 ("One lint config holds every rule about a file's own imports"). The
  name rules of §4 stay in `.oxlintrc.json`.
- **Depends on:** ADR 0018 §3 for the index rule it checks, and
  [ADR 0003](0003-one-typed-daemon-contract-behind-every-frontend.md) for
  the contract importing nothing outside itself.

## Context

ADR 0018 §4 put every import rule in oxlint's `no-restricted-imports`,
configured in `.oxlintrc.json`. Two things followed from that tool.

**A component was guarded only once someone listed it.** Each module got a
pattern by hand, and oxlint overrides replace a rule's options rather than
merging them, so each override repeated the patterns it still needed. On
`main` at a547569 the config held 40 index patterns for seven components
(core, leasing, gateway, `drivers/ios`, `drivers/android`, agent-device,
`core/capacity`). Components with an index but no pattern were open:
imports past the index of `contract/`, `ports/` and
`core/capacity/strategies/` passed lint. Architecture rule 14 says every
component is entered through its index; the check covered the ones
someone remembered.

**oxlint reads one file's imports, so it cannot see a cycle.** `http` and
`daemon` import each other: `daemon/main.ts` imports `http/app.ts`, and
`http/errors.ts`, `http/app.ts` and `http/dispatcher-session.ts` import
files in `daemon/`. Nothing failed.

## Decision

### 1. dependency-cruiser holds every rule about which path a file may import

`.dependency-cruiser.mjs` holds the rules, and `pnpm lint` and the commit
hook run it over `src/`, `e2e/` and `ui/`.

- **Index only, by rule rather than by list.** A component is a directory
  under `src/` that has an `index.ts`, at any depth; the config finds them
  when it loads. From outside a component, a file may import only its
  `index.ts` or its `testing.ts`, and only a `*.test.ts` file or a
  `test-*.ts` helper may import a `testing.ts` or `test-*.ts` file at all.
  A new component is guarded the moment it has an index. A directory with
  no index (`src/drivers/`, `src/http/` today) is not a component; each
  file in it stands alone. Each component's rule also covers its compiled
  copy under `dist/`, which e2e imports, whether or not `dist/` is built.
- **Direction.** The per-directory rules ADR 0018 §4 listed moved
  unchanged: core imports no leasing, driver, agent-device, `fs` or
  `child_process`; leasing no driver, agent-device, `fs` or
  `child_process`; drivers no agent-device; agent-device no `fs` or
  `child_process`; only `daemon/main.ts` in the daemon imports the gateway;
  the gateway no driver, `http/`, `cli/` or `mcp/`, and from `daemon/` only
  `dispatch.ts`; the contract nothing outside itself. Test files keep the
  exemption §4 gave them; a `testing.ts` file follows its module's rules.
- **No cycles between components.** `.dependency-cruiser.cycles.mjs` fails
  any two directories under `src/` whose production files import each
  other, directly or through a third, even when no single file is on a
  cycle. Test files and `testing.ts` are left out, because a test may build
  another component through its `testing.ts` (ADR 0018 §3) and that
  component's wiring may import the tested one back.

### 2. oxlint keeps the rules about imported names

dependency-cruiser sees modules, not the names imported from them. The
gateway's two allow-lists, the names it may import from core's index and
from leasing's index, stay in `.oxlintrc.json`, and nothing else does.

### 3. Each rule is proven, and today's breaches only shrink

`src/lint-rules.test.ts` holds a fixture for each rule that fails without
it. Breaches that existed when the config landed are recorded, not fixed:
24 path breaches in `.dependency-cruiser-known-violations.json`, which
`pnpm lint` reads with `--ignore-known`, and 6 cycles in
`.dependency-cruiser-known-cycles.json`. dependency-cruiser cannot yet
ignore known violations between directories, so the cycle check runs as a
unit test that compares the cycles it finds with that file, both ways.
Another unit test fails when either file holds more entries than it did at
adoption, so they only shrink.

### 4. dependency-cruiser parses with TypeScript 6

dependency-cruiser parses TypeScript with the `typescript` package
installed beside it and supports only versions below 7; the project builds
with 7. `pnpm-workspace.yaml` gives dependency-cruiser its own
`typescript` 6 through `packageExtensions`, so the project's compiler is
untouched.

## Consequences

- A component is guarded from its first commit. Adding one changes no lint
  config.
- Cycles between components fail CI. The six known entries cover three
  loops: `http` and `daemon`, `gateway` and `daemon`, and `agent-device`
  through `http` and `daemon`. The gateway loop comes from
  `daemon/dispatch.ts`, which ADR 0018 §4 lets the gateway import, so
  moving the dispatch contract out of `daemon/` is what removes it.
- Import rules live in two tools, split by kind: paths and the graph in
  dependency-cruiser, imported names in oxlint. A reader asking "may this
  file import that path" reads one config, and "may it import that name"
  the other. ADR 0018 rejected two mechanisms for the same kind of rule;
  this keeps one mechanism per kind.
- Two dev dependencies: `dependency-cruiser`, and the `typescript` 6 it
  parses with.
- The commit hook and `pnpm lint` take a few seconds longer: the check
  reads every import in the project, not only the staged files.

## Alternatives considered

- **Generate `.oxlintrc.json` from the directory list.** Keeps one tool and
  closes the "only listed components" gap, but oxlint still cannot see a
  cycle, and the generated overrides still repeat every pattern.
- **A test of our own that walks the imports.** Can see cycles, but it is
  code we maintain for a job a maintained tool does.
- **Move the name rules too, by giving leasing a narrower entry point for
  the gateway.** Would put every import rule in one tool, but it changes
  leasing's surface for the sake of a lint tool; it can follow later if the
  split proves confusing.

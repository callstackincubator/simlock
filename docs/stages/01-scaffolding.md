# Stage 01 — Scaffolding

Goal: a buildable, testable, lintable TypeScript project with the module
layout the architecture prescribes. No business logic.

## Stack decisions (binding for all later stages)

- **TypeScript, strict mode**, ESM (`"type": "module"` already set), Node ≥ 22
  (`engines` field). Target/lib: ES2023, module resolution `node16`/`nodenext`.
- **vitest** for tests, **oxlint** for linting, **oxfmt** for formatting.
  Dev dependencies only.
- **Zero runtime dependencies.** Arg parsing via `node:util` `parseArgs`,
  sockets via `node:net`, no CLI/DI/ORM frameworks. Adding a runtime dep
  requires an explicit note in the stage doc that introduces it.

## Tests first

- One smoke test (`src/index.test.ts` or similar) asserting a trivial export,
  proving the vitest + TS pipeline works end to end.

## Implement

1. `tsconfig.json` — strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes,
   outDir `dist/`.
2. `package.json` scripts: `build` (tsc), `test` (vitest run), `typecheck`
   (tsc --noEmit), `lint` (oxlint), `format` (oxfmt), `format:check`
   (oxfmt --check), `check` (typecheck + lint + format:check + test).
3. Default configs for oxlint (`.oxlintrc.json`) and oxfmt; format the repo
   once.
4. Directory skeleton with placeholder `index.ts` per module — this encodes
   architecture rule 4 (one module per functionality):

   ```
   src/
     core/           # lease engine, queue, registry, capacity, state machine, reaper
     ports/          # external-API interfaces + real adapters + fakes (stage 02)
     bus/            # event bus (stage 03)
     drivers/
       ios/
       android/
     daemon/         # socket server, protocol (stage 09)
     cli/            # thin client (stage 10)
   ```

5. `bin` entry in package.json pointing at `dist/cli/main.js` (stub for now).

## Watch out

- Do not add abstractions or types for future stages — empty modules only.
- oxfmt, oxlint, and tsc must agree (no formatting/lint churn in later
  diffs); run `format` once in this stage so the baseline is clean.

## Acceptance criteria

- [ ] `pnpm check` passes (typecheck + lint + tests) from a clean clone.
- [ ] `pnpm build` emits `dist/` and `node dist/cli/main.js` runs (may just
      print a version stub).
- [ ] Directory skeleton matches the layout above.
- [ ] No runtime dependencies in package.json.

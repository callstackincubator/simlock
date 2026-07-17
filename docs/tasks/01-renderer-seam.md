# Task 1 of 5: Extract a Renderer seam (pure refactor) + pin the JSON agent contract

You are implementing Task 1 of 5 in a series that modernizes the CLI of the "pitlane" project (control plane for iOS simulators / Android emulators, used primarily by coding agents).

## Repo context (read this carefully)

- Repo: /Users/szymon.chmal/Projects/pitlane. Branch `feat/modern-cli` is already checked out — work and commit there. Do NOT push. Do NOT switch branches.
- Package manager is pnpm ONLY (`npm`/`npx` are blocked by devEngines). `pnpm check` runs typecheck + lint + format:check + tests. `pnpm format` fixes formatting. Run `pnpm format` before committing — pre-commit hooks (lefthook) run `oxfmt --check`, `oxlint`, and `fallow audit` and will reject unformatted code.
- Binding rules in docs/agent-rules/ (architecture.md, events.md, safety.md) — read architecture.md; rule 8 says the CLI is a thin rendering client of the daemon, rule 9 says external APIs go behind injected interfaces.
- Read first, fully: AGENTS.md, docs/CLI.md, src/cli/index.ts, src/cli/index.test.ts, src/cli/protocol.ts.
- Use conventional commit messages (e.g. `refactor(cli): ...`).

## Goal

Restructure src/cli/index.ts so ALL user-facing output flows through a `Renderer` interface, with a `JsonRenderer` that reproduces today's output **byte-for-byte**. This is a pure refactor — zero behavior change, zero new dependencies. It prepares for a `HumanRenderer` (clack-based, added in Task 2).

## Requirements

1. Create `src/cli/render.ts` (or `src/cli/render/` if you prefer multiple files) exporting:
   - `interface Renderer` with semantic methods covering every output the CLI produces today. Design the methods around meaning, not formatting — e.g. `result(value)` (JSON result lines), `progress(event)` (lease progress lines on stderr), `status(status)` (the status report), `info(message)` (plain informational lines like "Daemon running", the config-set confirmation), `error(message)` and `usage(text)` (stderr error + usage). Adjust/extend as the code demands — you decide the exact surface after reading index.ts, but every `environment.stdout.write` / `environment.stderr.write` in command handlers must go through the renderer.
   - `JsonRenderer` implementing it with EXACTLY the current bytes: `JSON.stringify(value)\n` for results, the current `progressLine` JSON on stderr, the current `formatStatus` plain text for non-`--json` status, the current plain strings for daemon/config messages. Move `writeResult`, `progressLine`, `formatStatus` logic into it.
2. IMPORTANT subtlety: today, "no --json" output is already a mix (plain text for `status`/`daemon`/`config set`, JSON for everything else). Do NOT change any of that in this task. Mode selection (TTY detection etc.) is Task 2's job. The renderer is constructed per command exactly reproducing today's per-command choices (e.g. status picks JSON vs plain based on the `--json` flag, same as now).
3. Add `readonly interactive?: boolean` to `CliEnvironment`, set in `defaultCliEnvironment()` from `process.stdout.isTTY === true`. It must have NO behavioral effect yet — it's plumbing for Task 2. Keep it optional so existing test environments compile unchanged.
4. Pin the JSON agent contract with new tests in src/cli/index.test.ts (or a new render.test.ts): exact-string (or inline-snapshot) assertions for at least — held-mode lease stdout line shape, progress lines on stderr (queued with queue_position, provisioning/booting with eta_seconds), `status --json` output, `status` plain-text output, an error case exit code + stderr, `release --all` without confirmation. Follow the existing test style (they spin up a real in-process DaemonServer via createHarness — reuse that helper).
5. Keep exports used elsewhere intact: `runCli`, `errorExitCode`, `parseDuration`, `DaemonClientError`, `DaemonConnection`, `CliEnvironment` (check `src/index.ts` and tests for what's imported).

## Acceptance criteria (verify each explicitly before committing)

- [ ] `pnpm check` passes (typecheck, lint, format:check, all tests).
- [ ] All PRE-EXISTING tests pass WITHOUT modification (you may add tests; do not alter existing assertions).
- [ ] No new dependencies in package.json; no changes outside src/cli/ and its tests.
- [ ] Every stdout/stderr write in command handlers goes through the Renderer.
- [ ] `git diff` shows no output-format change: search your diff for any string literal changes to output text — there must be none.

## Process

Implement → run `pnpm check` → then do a critical SELF-REVIEW pass: read your full `git diff`, look for behavior drift, dead code, naming inconsistent with the codebase (this repo uses long descriptive names, no abbreviations, arrow-function helpers at bottom of file), missing renderer routing → fix findings → `pnpm format` → commit your changes with a conventional message.

Report back: what you changed (files + shape of the Renderer interface), test results, the commit hash, and any concerns or deviations from this spec.

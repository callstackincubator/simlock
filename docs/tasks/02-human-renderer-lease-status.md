# Task 2 of 5: Dependencies + output-mode policy + HumanRenderer for `lease` and `status`

You are implementing Task 2 of 5 in a series that modernizes the CLI of the "pitlane" project (control plane for iOS simulators / Android emulators; primary users are coding agents, but humans should get a delightful modern CLI experience).

## Repo context

- Repo: /Users/szymon.chmal/Projects/pitlane. Branch `feat/modern-cli` is checked out — work and commit there. Do NOT push, do NOT switch branches.
- Task 1 (already committed) extracted a `Renderer` seam: `src/cli/render.ts` has a `Renderer` interface + `JsonRenderer` reproducing the legacy output byte-for-byte; `CliEnvironment` has an optional `interactive` flag (from `process.stdout.isTTY`); command handlers in `src/cli/index.ts` route all output through the renderer.
- Package manager is pnpm ONLY (npm/npx blocked by devEngines). `pnpm check` = typecheck + lint + format:check + tests. Run `pnpm format` before committing; lefthook pre-commit runs oxfmt --check, oxlint, fallow audit.
- Binding rules: docs/agent-rules/architecture.md (rule 8: CLI is a thin rendering client — no decision logic beyond rendering). Read AGENTS.md.
- Read first, fully: src/cli/render.ts, src/cli/index.ts, src/cli/index.test.ts, docs/CLI.md.
- Conventional commit messages (e.g. `feat(cli): ...`).

## 2a. Dependencies

Add runtime deps with pnpm: `@clack/prompts` (^1.7.0) and `picocolors` (^1.1.1). No other new deps.

## 2b. Output-mode policy (this is a deliberate, documented contract change)

Renderer selection per invocation:

- `--json` flag → `JsonRenderer`, always.
- no `--json` AND `environment.interactive === true` → `HumanRenderer`.
- no `--json` AND not interactive (piped/redirected — the agent case) → `JsonRenderer`.

Consequences you must handle:

- The legacy plain-text defaults (the `formatStatus` text for `status`, "Daemon running/stopping/stopped" strings, the config-set message) are superseded: non-TTY gets JSON for those now (`status` without `--json` in a pipe prints the same JSON as `--json`; daemon start prints `{"status":"running"}`; give `info()` a sensible JSON-mode representation). Update the Task-1 pinned test that asserts plain-text `status` accordingly (that pin is intentionally being changed here — this is the ONLY behavioral change to non-TTY output; everything else must stay byte-identical, and existing JSON pins must not change).
- Update docs/CLI.md: add a short "Output modes" section near the top documenting: JSON when `--json` or when stdout is not a TTY; human-friendly rendering only in interactive terminals; progress/diagnostics on stderr in both modes; `NO_COLOR` respected.

## 2c. HumanRenderer (new, in src/cli/render.ts or a sibling file)

Implements the full `Renderer` interface using @clack/prompts + picocolors. This task styles `lease` and `status` deeply; other methods get a reasonable simple human representation for now (readable `key: value` lines / plain messages — Task 3 will refine them). Design notes:

- Decoration and progress go to **stderr**; keep stdout for real results. @clack/prompts supports an `output` stream option on its primitives (CommonOptions) — verify the exact API in node_modules/@clack/prompts (check the .d.ts) and pass the environment's stderr. The HumanRenderer must write through the injected `CliEnvironment` stdout/stderr, not global process streams, so tests can capture output (tests can pass PassThrough streams if clack needs real streams — you have freedom here, but injection must be preserved).
- picocolors: create it in a way that respects NO_COLOR / non-TTY (picocolors does this automatically via `pc.createColors` or its default export — verify).
- `lease` (held mode), the flagship experience:
  - clack `intro` banner (e.g. "pitlane").
  - one clack `spinner` driven by progress events: queued → "Waiting in queue (position N)", provisioning → "Provisioning device (~Ns)", booting → "Booting (~Ns)", reclaiming → "Reclaiming capacity (~Ns)" — use `spinner.message()` for updates.
  - on grant: stop the spinner with a success message; render the lease details (device model, OS, platform, UDID, lease id) as a clack `note` or styled block; then a line like "Holding lease — press Ctrl+C to release".
  - on SIGINT/SIGTERM release: clack `outro` ("Lease released").
  - detached mode: details + outro immediately, no holding message.
  - You will likely need to extend the `Renderer` interface with lease-specific semantic methods (e.g. `leaseGranted(result, {held})`, `leaseReleased()`); give `JsonRenderer` implementations that reproduce its current bytes exactly.
- `status`: styled report — daemon health (colored), global capacity, per-platform capacity (ios/android), device list with colored states, lease list, queue depth. Aligned and scannable; use picocolors (dim labels, bold values, green/yellow/red for states) — no heavy box-drawing needed.
- Errors in human mode: `clack.log.error` or a red ✖ line on stderr; usage text stays readable.

## 2d. Tests

- Existing JSON pins (except the one intentionally changed plain-text status pin) must pass unchanged.
- New human-mode tests: environment with `interactive: true`; assert on ANSI-stripped output (write a small stripAnsi helper) containing the key content: lease flow shows queue position and device details; status shows health + capacity; results still land such that stdout carries the lease result content. Follow existing test style (real in-process daemon via the createHarness helper).

## Acceptance criteria (verify each explicitly before committing)

- [ ] `pnpm check` passes.
- [ ] `--json` output for every command byte-identical to Task 1 pins.
- [ ] Non-TTY no-flag output is JSON everywhere (the documented contract change), and docs/CLI.md documents the policy.
- [ ] Interactive `lease` renders intro → live spinner updates → lease details → holding line → outro on signal; interactive `status` renders the styled report.
- [ ] HumanRenderer writes decoration/progress to stderr, results to stdout; all writes go through the injected environment streams.
- [ ] No decision logic added to the CLI beyond rendering (architecture rule 8).

## Process

Implement → `pnpm check` → critical SELF-REVIEW of your full `git diff` (behavior drift on JSON paths, stream misuse, naming consistency with the codebase, dead code) → fix findings → `pnpm format` → commit your changes with a conventional message.

Report back: what changed, the final Renderer interface shape, how clack output-stream injection worked out, test results, commit hash, and any concerns/deviations.

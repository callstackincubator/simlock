# Task 3 of 5: HumanRenderer for the remaining commands

You are implementing Task 3 of 5 in a series that modernizes the CLI of the "pitlane" project (control plane for iOS simulators / Android emulators; primary users are coding agents, but humans should get a delightful modern CLI experience).

## Repo context

- Repo: /Users/szymon.chmal/Projects/pitlane. Branch `feat/modern-cli` is checked out — work and commit there. Do NOT push, do NOT switch branches.
- Tasks 1–2 (already committed): `src/cli/render.ts` has a `Renderer` interface, a byte-exact `JsonRenderer`, and a clack-based `HumanRenderer` used when the terminal is interactive and `--json` is absent. `lease` and `status` already render beautifully; the remaining commands fall back to simple generic output in human mode.
- Package manager is pnpm ONLY (npm/npx blocked by devEngines). `pnpm check` = typecheck + lint + format:check + tests. Run `pnpm format` before committing; lefthook pre-commit runs oxfmt --check, oxlint, fallow audit.
- Binding rules: docs/agent-rules/architecture.md (rule 8: CLI is a thin rendering client), docs/agent-rules/safety.md (destructive ops need explicit confirmation). Read AGENTS.md.
- Read first, fully: src/cli/render.ts (and siblings), src/cli/index.ts, src/cli/index.test.ts, docs/CLI.md.
- Conventional commit messages (e.g. `feat(cli): ...`).

## Goal

Give every remaining command a deliberate, styled human rendering, and move interactive confirmation to clack. JSON mode must remain byte-identical throughout.

## Per-command human renderings

Extend the `Renderer` interface with semantic methods where the generic `result()` isn't expressive enough. For each, `JsonRenderer` keeps emitting exactly the current JSON bytes.

- `list --devices|--leases|--rules`: aligned columnar output (compute column widths from content; dim headers). Devices: id, platform, model, os, state (colored: green ready, yellow booting/reclaiming, dim shutdown). Leases: id, requester, device, granted-at (human-relative time, e.g. "3m ago"). Rules: name, description/target. Empty list → a dim "No devices/leases/rules" line, not an empty table.
- `cleanup [--dry-run]`: dry-run renders each planned action as `→ <rule>: <action> <target> (<reason>)`; real run renders performed actions with a ✓ per action and a one-line summary ("3 actions, 0 failures"). Nothing to do → "Nothing to clean up".
- `doctor [--fix]`: each finding as a line with a colored glyph — ✓ (ok/fixed, green), ✗ (problem, red), ! (warning, yellow) — plus a closing summary line. With `--fix`, show what was corrected.
- `nuke` and `release --all` (destructive — see safety.md): in interactive mode, replace the readline `confirm` with a clack `confirm` prompt preceded by a red warning line stating exactly what will be destroyed. `--yes` bypasses as today. clack cancel (`isCancel`) counts as "not confirmed" and must take the same code path as answering no (today: UsageError, exit 2). Non-interactive without `--yes` keeps failing exactly as today. Wire this through the existing `environment.confirm` seam so tests can stub it — the clack-based confirm becomes the default implementation when interactive.
- `events [--follow]`: each event as `<dim relative-or-clock time> <colored event name> <compact one-line payload summary>`. Keep `--follow` streaming line-by-line.
- `daemon start|stop|status|logs`: short status lines with a colored state word ("Daemon ● running" green / "stopped" dim / "stopping" yellow). `logs` output stays raw (it is already log text).
- `config` / `config get`: render nested config as an indented `key: value` tree with dim keys. `config set`: confirmation line with the key, new value, and the "takes effect on daemon restart" note.

## Tests

- For each command above, at least one human-mode test (environment with `interactive: true`, ANSI-stripped assertions on key content), following the existing harness style.
- Confirm flow tests: interactive nuke — confirmed proceeds, declined/cancelled exits with the same code/message as today's unconfirmed path; `--yes` skips the prompt entirely.
- All existing JSON pins pass unchanged.

## Acceptance criteria (verify each explicitly before committing)

- [ ] `pnpm check` passes.
- [ ] Every command listed above has a deliberate human rendering (no generic JSON-ish fallback left in human mode).
- [ ] JSON mode byte-identical for every command (existing pins untouched and passing).
- [ ] Destructive commands show a red warning + clack confirm when interactive; `--yes` bypass and non-interactive behavior unchanged.
- [ ] All output still flows through the injected environment streams (no direct process.stdout/stderr writes in renderers or handlers).

## Process

Implement → `pnpm check` → critical SELF-REVIEW of your full `git diff` (JSON-path drift, missed commands, inconsistent styling between commands, naming consistency, dead code) → fix findings → `pnpm format` → commit your changes with a conventional message.

Report back: what changed, any Renderer interface additions, test results, commit hash, and any concerns/deviations.

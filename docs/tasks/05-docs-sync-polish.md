# Task 5 of 5: Documentation sync + polish

You are implementing Task 5 of 5 in a series that modernizes the CLI of the "pitlane" project (control plane for iOS simulators / Android emulators; primary users are coding agents, but humans should get a delightful modern CLI experience).

## Repo context

- Repo: /Users/szymon.chmal/Projects/pitlane. Branch `feat/modern-cli` is checked out — work and commit there. Do NOT push, do NOT switch branches.
- Tasks 1–4 (already committed) delivered: a `Renderer` seam with byte-exact `JsonRenderer` (agents: `--json` or non-TTY) and clack-based `HumanRenderer` (interactive terminals); styled renderings for every command; clack confirms for destructive ops; citty-based command tree with generated `--help`.
- Package manager is pnpm ONLY (npm/npx blocked by devEngines). `pnpm check` = typecheck + lint + format:check + tests. Run `pnpm format` before committing; lefthook pre-commit runs oxfmt --check, oxlint, fallow audit.
- Read first, fully: docs/CLI.md, README.md, docs/ABOUT.md, docs/ARCHITECTURE.md, src/cli/ (all files), and skim `git log --oneline origin/main..HEAD` + the diff to know exactly what shipped.
- Conventional commit messages (e.g. `docs: ...`).

## Goal

Make the documentation exactly match the shipped CLI behavior, and close remaining polish gaps. Documentation drift is treated as a defect in this repo (see AGENTS.md — EVENTS.md sync rule is an example of the standard).

## Requirements

1. **docs/CLI.md full pass**:
   - Verify/finish the "Output modes" section (JSON when `--json` or stdout not a TTY; human rendering only in interactive terminals; progress/diagnostics to stderr in both modes; `NO_COLOR` respected; exit codes unchanged).
   - Ensure every command section matches actual flags, defaults, confirmation behavior (clack confirm vs `--yes`), and help output. Fix any statement the implementation contradicts (e.g. the old claim that plain-text status is the no-flag default).
   - Keep the held-mode lease JSON example and progress-line examples accurate for non-TTY/agent usage.
2. **README.md check**: if it shows CLI invocations or output examples, make them match reality (agent examples should show JSON lines; you may add one short human-mode mention). Do not rewrite the README beyond accuracy fixes.
3. **NO_COLOR / CI verification**: confirm by reading the code (and a quick manual run if practical) that `NO_COLOR=1` and non-TTY output contain no ANSI escapes; if there's a gap, fix it in the renderer.
4. **Polish sweep** (small fixes only — anything big, report instead of implementing):
   - Consistent capitalization/tone across human-mode messages; consistent glyph usage (✓ ✗ ! → ●).
   - Help descriptions read well and match docs/CLI.md wording.
   - `pitlane` with no args in a TTY: should show the generated help (not an error); verify and fix if not.
5. If you find behavior that contradicts docs and the fix is ambiguous (docs wrong vs code wrong), prefer updating docs to match code UNLESS the code contradicts the exit-code table or the JSON agent contract in docs/CLI.md — those are load-bearing; in that case fix the code and say so in your report.

## Acceptance criteria (verify each explicitly before committing)

- [ ] `pnpm check` passes.
- [ ] docs/CLI.md accurately describes every command's flags, output in both modes, confirmation behavior, and exit codes.
- [ ] README CLI examples (if any) are accurate.
- [ ] No ANSI escapes in non-TTY or NO_COLOR output (verified).
- [ ] JSON pins still byte-identical (no accidental behavior change from polish).

## Process

Implement → `pnpm check` → critical SELF-REVIEW of your full `git diff` (docs vs code cross-check per command, no accidental behavior drift) → fix findings → `pnpm format` → commit your changes with a conventional message.

Report back: what changed, any doc/code contradictions you found and which side you fixed, test results, commit hash, and any concerns/deviations.

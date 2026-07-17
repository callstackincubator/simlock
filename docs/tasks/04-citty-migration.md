# Task 4 of 5: Migrate command parsing and help to citty

You are implementing Task 4 of 5 in a series that modernizes the CLI of the "pitlane" project (control plane for iOS simulators / Android emulators; primary users are coding agents, but humans should get a delightful modern CLI experience).

## Repo context

- Repo: /Users/szymon.chmal/Projects/pitlane. Branch `feat/modern-cli` is checked out — work and commit there. Do NOT push, do NOT switch branches.
- Tasks 1–3 (already committed): all output flows through a `Renderer` (`JsonRenderer` byte-exact for agents, clack-based `HumanRenderer` for interactive terminals). Command handlers still use a hand-rolled `switch` dispatch + `node:util` `parseArgs` with hand-written usage strings.
- Package manager is pnpm ONLY (npm/npx blocked by devEngines). `pnpm check` = typecheck + lint + format:check + tests. Run `pnpm format` before committing; lefthook pre-commit runs oxfmt --check, oxlint, fallow audit.
- Binding rules: docs/agent-rules/architecture.md. Read AGENTS.md.
- Read first, fully: src/cli/index.ts, src/cli/render.ts (and siblings), src/cli/index.test.ts, docs/CLI.md, src/cli/main.ts.
- Conventional commit messages (e.g. `refactor(cli): ...`).

## Goal

Replace the hand-rolled dispatch, `parseArgs` calls, and terse usage strings with a citty `defineCommand` tree and generated help — while preserving the public behavioral contract exactly: same flags, same exit codes, same strictness, same JSON output.

## Requirements

1. Add runtime dep with pnpm: `citty` (^0.2.2).
2. Define the command tree in a new `src/cli/commands.ts` (or `src/cli/commands/` directory): a root command with subcommands `lease` (with nested `renew`), `release`, `status`, `list`, `cleanup`, `doctor`, `nuke`, `events`, `daemon` (nested `start|stop|status|logs`), `config` (nested `get|set`). Declare every current flag with type, description, and alias exactly matching today's surface (check each `commandArgs` call in index.ts; `-h` alias for `--help` stays). Use citty arg types (`boolean`, `string`, `positional`, `enum` where it fits, e.g. `--platform`).
3. Programmatic execution: keep `runCli(argv, environment): Promise<number>` as the single entry point with its exact signature — `src/cli/main.ts` and all tests depend on it. Use citty's `runCommand` (NOT `runMain` — it calls process.exit) and route errors through the existing mapping: `UsageError` → 2, `DaemonClientError` → the DAEMON_ERROR_EXIT_CODES table, other → 1. Command handlers receive the `CliEnvironment`/renderer via closure or citty's context `data` — keep handlers thin, calling the same daemon client code as today.
4. Help: `--help`/`-h` on any command (and bare `pitlane`) renders citty's generated usage via `renderUsage` through the renderer to stdout, exit 0. Give each command and arg a good one-line description sourced from docs/CLI.md so the generated help is genuinely useful (this replaces the old single-line usage strings). Usage errors keep printing usage/hint to stderr with exit 2.
5. STRICTNESS — critical, verify with tests: `node:util` `parseArgs` in strict mode rejected unknown flags; citty does NOT by default (unknown flags land in the parsed args object). Preserve today's behavior: after parsing, compare parsed arg keys against the declared args (plus `_` positionals) and throw `UsageError("Unknown option: --<flag>")` for anything undeclared. Also preserve: required-flag validation (`lease` without `--platform` → exit 2 mentioning `--platform`), unexpected-positional rejection where the current code rejects them (e.g. `daemon` with extra positionals, `release` with both id and `--all`), and duration parsing via the existing `parseDuration`.
6. Keep exports intact: `runCli`, `errorExitCode`, `parseDuration`, `DaemonClientError`, `DaemonConnection`, `CliEnvironment` (check src/index.ts and tests).
7. Delete the now-dead hand-rolled dispatch/usage code. Net effect on index.ts should be a significant simplification.

## Tests

- Existing tests must pass. Usage-error assertions in existing tests check that stderr contains the flag name and "Usage:" — if citty's generated wording differs slightly, you may adapt ONLY the wording-level assertions, never exit codes or the JSON pins.
- New tests: unknown flag → exit 2 + message naming the flag (for at least one command); `--help` on root and on `lease` prints generated usage containing the flag descriptions and exits 0; nested subcommand routing (`lease renew`, `daemon logs`, `config set`) still works.

## Acceptance criteria (verify each explicitly before committing)

- [ ] `pnpm check` passes.
- [ ] Every documented flag/subcommand parses exactly as before; all JSON pins byte-identical.
- [ ] Unknown flags and missing required flags exit 2 with a message naming the offender.
- [ ] `--help` everywhere prints rich generated usage (command description + per-flag descriptions), exit 0.
- [ ] `runCli` signature unchanged; no process.exit anywhere in the CLI module; main.ts still sets process.exitCode from runCli's return.
- [ ] Hand-rolled usage strings and parseArgs plumbing removed.

## Process

Implement → `pnpm check` → critical SELF-REVIEW of your full `git diff` (flag parity command-by-command against the old parseArgs tables, exit-code paths, strictness, dead code) → fix findings → `pnpm format` → commit your changes with a conventional message.

Report back: what changed, flag-parity confirmation per command, test results, commit hash, and any concerns/deviations.

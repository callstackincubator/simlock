# Spec review: task/147 (`simlock instructions`)

Inputs: `git diff origin/main...origin/task/147`, the issue body, and `docs/internal/agent-rules/{documentation,testing,architecture}.md`. No other file was opened and nothing was run, so `pnpm check` is not verified here.

## 1. Scope and Done when

| Line | Delivered by |
|---|---|
| Never call platform tools; use `simlock simctl` / `simlock adb` | `src/instructions/index.ts` hunk, "Never call the platform tools directly" section (lines 16-20) |
| How to lease: `SIMLOCK_AGENT_ID`, `simlock catalog` first, `simlock lease` in background or `--detach` + `lease renew` before `ttlDeadline`, one JSON line on stdout, progress on stderr | `src/instructions/index.ts` "Lease a device" section (lines 22-28) |
| One lease per agent; `--all` / `nuke` are operator commands; release via `simlock release <lease-id>` or exiting the holder | `src/instructions/index.ts` "One lease, and give it back" (lines 30-34) |
| Never pass `--allow-download` unless told to | `src/instructions/index.ts:35` |
| Exit codes 10, 11, 13, 14 and what to do | `src/instructions/index.ts` "Exit codes to handle" (lines 37-44) |
| Reach a leased device: `environment` block, `simlock simctl`/`adb`, refused verbs are refused on purpose | `src/instructions/index.ts` "Reach the leased device" (lines 46-53) |
| Over MCP: four tools; `lease_status` after compaction | `src/instructions/index.ts` "Over MCP" (lines 55-64) |
| `src/instructions/index.ts`: `AGENT_INSTRUCTIONS` + `renderInstructions("text"\|"json")`, sole source | new file; CLI calls `renderInstructions`, MCP reads `AGENT_INSTRUCTIONS`, no copy elsewhere |
| CLI `instructions` command: Markdown by default, `--json` object, other flags `USAGE`/2, no daemon, in `--help` | `src/cli/index.ts` hunks: USAGE line 59, dispatch line 613-614, `runInstructions` lines 877-895 (no client is created). See note on `--help` below. |
| MCP resource `simlock://instructions` (`text/markdown`) returning `AGENT_INSTRUCTIONS`; `resources` capability; no new tools | `src/mcp/server.ts` hunks (capability line 100, `registerResource` lines 104-116); no `registerTool` added |
| `docs/CLI.md` section and intro exception list | `docs/CLI.md` hunks at line 6 and lines 850-869 |
| `README.md` one sentence under Getting started, one under MCP integration | `README.md` hunks at lines 176-177 and 200-201 |
| `simlock --help` lists the command | `src/cli/index.ts:59` |
| `pnpm check` green | not verifiable in this review (not run) |
| Tests (6 listed) | see section 3 |

## 2. Beyond the specification

- `--help` / `-h` accepted by `instructions` (exit 0, prints usage).
- Four driver constants exported and `REFUSED_SIMCTL_VERBS` retyped to `ReadonlySet<string>` in `src/drivers/ios/index.ts` and `src/drivers/android/index.ts`, neither listed under "Modules touched" (implied by the test line "derive the expected list from the drivers' refusal constants").
- The text states CLI behaviours the Scope does not: `--os`, `--timeout`, `--no-wait`, `--export-env`, gateway `simlock simctl/adb --lease <lease-id>`, `device.driverDeviceId`, the names and meanings of `SIMLOCK_IOS_DEVICE_SET` and `ANDROID_ADB_SERVER_PORT`, `runtime delete`, `emu avd stop`, `emu avd snapshot delete`, and an adb pre-subcommand option allowlist (`-s`, `-t`, `-d`, `-e`).
- MCP resource `title` and `description` metadata (harmless; not a copy of the text).

## 3. Tests

| Test | Title is a spec claim | Body proves it |
|---|---|---|
| `e2e/agent-instructions.test.ts:9` prints on stdout, exits 0, no daemon | yes | yes: code 0, stdout equals `AGENT_INSTRUCTIONS`, no socket at `env.socketPath` |
| `e2e/agent-instructions.test.ts:22` `--json` one object whose `instructions` equals text output | yes | yes: one stdout line, parsed object equals `{instructions: text.stdout}` |
| `e2e/agent-instructions.test.ts:33` `--bogus` fails USAGE, exit 2 | yes | yes |
| `src/instructions/index.test.ts:17` name no path inside this repository | yes | partially; see note |
| `src/instructions/index.test.ts:22` name every refused passthrough verb the drivers refuse | yes | partially; see note |
| `e2e/mcp-session.test.ts:11` lists `simlock://instructions`, reading returns CLI text | yes | yes: `listResources` contains uri + mimeType; `readResource` contents equal CLI stdout |

## Findings

- [note] The `instructions` command accepts `--help`/`-h` and exits 0, while the spec says any flag other than `--json` is `USAGE` exit 2; the only justification is the top-level banner's "Run 'simlock <command> --help'", and the help path has no test. Evidence: `src/cli/index.ts:883`.
- [note] The test titled "name no path inside this repository" proves only that the text matches neither `docs/` nor `.md` (exactly what the spec prescribed), so a path such as `src/instructions/index.ts` or `package.json` would pass; the title claims more than the body proves (testing rule 1). Evidence: `src/instructions/index.test.ts:17`.
- [note] The test titled "name every refused passthrough verb the drivers refuse" derives its list from four exported constants, but the text also names `runtime delete` as refused by `simlock simctl` and `--set`/`--profiles` as refused, neither of which the test derives from a driver constant (the iOS `CALLER_SUPPLIED_SCOPE_FLAGS` visible in the diff context stays unexported and unread); whether the driver refuses `runtime delete` at all cannot be confirmed from the files named for this review, so the test does not see everything its title covers (testing rule 4). Evidence: `src/instructions/index.test.ts:25`, `src/instructions/index.ts:52`.
- [note] The diff edits `src/drivers/ios/index.ts` and `src/drivers/android/index.ts` (exports, and a type change on `REFUSED_SIMCTL_VERBS`) although the spec's "Modules touched" lists only `src/instructions`, `src/cli`, `src/mcp`, `docs/CLI.md`, and `README.md`. Evidence: `src/drivers/ios/index.ts:82`, `src/drivers/android/index.ts:230`.
- [note] The printed text asserts CLI behaviours the spec never stated and this review could not verify (`--os`, `--timeout`, `--no-wait`, `--export-env`, gateway `--lease <lease-id>`, `device.driverDeviceId`, `SIMLOCK_IOS_DEVICE_SET`, `ANDROID_ADB_SERVER_PORT`, `emu avd stop`, `emu avd snapshot delete`, the `-s`/`-t`/`-d`/`-e` allowlist); each is a claim the change owns (architecture rule 13), and naming and explaining specific `environment` keys goes beyond "the `environment` block" the Scope asked for. Evidence: `src/instructions/index.ts:49`.

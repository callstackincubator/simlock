# Spec review: task/147 (`simlock instructions`)

Reviewed `origin/main...origin/task/147` against the issue body plus
`docs/internal/agent-rules/documentation.md`, `testing.md`, and `architecture.md`.
Nothing was executed beyond producing the diff; `pnpm check` was not run.

## 1. Scope and Done when, line by line

Scope (what the text must tell an agent):

| Line | Delivered by |
| --- | --- |
| Never call platform tools directly; use `simlock simctl` / `simlock adb` | `src/instructions/index.ts:16-20` ("Never call the platform tools directly") |
| How to lease: stable `SIMLOCK_AGENT_ID`, `simlock catalog` first, `simlock lease --platform … --device …` in background or `--detach` + `simlock lease renew` before `ttlDeadline`, one JSON line on stdout, progress on stderr | `src/instructions/index.ts:22-28` ("Lease a device") |
| One lease per agent; `--all` and `nuke` are operator commands; release with `simlock release <lease-id>` or by exiting the holder | `src/instructions/index.ts:30-34` |
| Never pass `--allow-download` unless told to | `src/instructions/index.ts:35` |
| Exit codes 10, 11, 13, 14 and what to do | `src/instructions/index.ts:37-42` |
| Reach a leased device: `environment` block, `simlock simctl`/`simlock adb`, refused verbs are refused on purpose (`create/erase/delete`, `kill-server`, `emu kill`) | `src/instructions/index.ts:46-53` |
| Over MCP: four tools, `lease_status` after a compaction | `src/instructions/index.ts:55-64` |

Technical spec:

| Line | Delivered by |
| --- | --- |
| `src/instructions/index.ts`: `AGENT_INSTRUCTIONS` + `renderInstructions("text" \| "json")`, single source | `src/instructions/index.ts:12, 70-74`; CLI and MCP both import it (`src/cli/index.ts:47`, `src/mcp/server.ts:4`) |
| CLI `instructions` command; Markdown on stdout; `--json` → `{"instructions": …}`; other flags `USAGE` exit 2; never touches the daemon; listed in `--help` | `src/cli/index.ts:59, 613-614, 881-895`. `--help`/`-h` is accepted with exit 0, see finding 1 |
| MCP resource `simlock://instructions`, `text/markdown`, returns `AGENT_INSTRUCTIONS`; `resources` capability; no new tools | `src/mcp/server.ts:25, 105-117` (capability declared by the SDK on `registerResource`; asserted in `e2e/mcp-session.test.ts:16`) |
| `docs/CLI.md`: `## simlock instructions` section + intro exception list | `docs/CLI.md:6`, `docs/CLI.md:850-869` |
| `README.md`: one sentence under Getting started, one under MCP integration | `README.md:176-177`, `README.md:200-201` (section placement not verifiable from the diff alone) |
| Contract/event changes: none | none made |

Tests asked for:

| Test | Delivered by |
| --- | --- |
| e2e: prints on stdout, exit 0, no socket under `SIMLOCK_HOME` | `e2e/agent-instructions.test.ts:9-20` |
| e2e: `--json` one object whose `instructions` equals the text output | `e2e/agent-instructions.test.ts:22-31` |
| e2e: `--bogus` → `USAGE`, exit 2 | `e2e/agent-instructions.test.ts:33-41` |
| unit: no repo path (`docs/`, `.md`) | `src/instructions/index.test.ts:28-49` |
| unit: every refused verb, derived from driver constants | `src/instructions/index.test.ts:51-71`, see finding 5 |
| e2e: MCP lists and reads the resource, same text as CLI | `e2e/mcp-session.test.ts:11-32` |

Done when:

| Line | Status |
| --- | --- |
| `instructions` and `--json` behave as specified, verified by e2e | delivered (`e2e/agent-instructions.test.ts`) |
| `simlock --help` lists the command | delivered (`src/cli/index.ts:59`) |
| MCP client can read `simlock://instructions` | delivered (`src/mcp/server.ts:105`, `e2e/mcp-session.test.ts:24`) |
| `docs/CLI.md` and `README.md` describe the command | delivered |
| `pnpm check` green | not verifiable in this review (not run) |

## 2. Things the specification did not ask for

- `instructions --help` / `-h` prints usage and exits 0 (`src/cli/index.ts:882-889`), plus a unit test for it (`src/cli/index.test.ts:2867`). The spec says any flag other than `--json` is `USAGE`.
- Positional arguments are rejected as `USAGE`, plus a unit test (`src/cli/index.ts:890-891`, `src/cli/index.test.ts:2876`). Not specified either way.
- iOS driver production change beyond exporting constants: a new `REFUSED_RUNTIME_OPERATION` constant and a rewrite of the `runtime delete` check and refusal message (`src/drivers/ios/index.ts:103-104, 1281-1286`). Android and iOS constants exported (`src/drivers/android/index.ts:230, 349`; `src/drivers/ios/index.ts:82, 94, 101`). Exporting is implied by the derived-list test; the new constant and refactor are not.
- The instructions text states CLI details the spec did not list: `--os`, `--timeout`, `--no-wait`, `--export-env`, `simlock simctl --lease` / `simlock adb --lease` for gateway devices, the grant field names `lease.id`, `lease.ttlDeadline`, `device.driverDeviceId`, the stderr error JSON shape, and two meanings for exit 13 (`src/instructions/index.ts:26-27, 39-41, 44, 48-50`).
- The text names and explains driver-owned environment keys (`SIMLOCK_IOS_DEVICE_SET`, `ANDROID_ADB_SERVER_PORT`) where the spec said "the `environment` block" (`src/instructions/index.ts:49`).
- The no-repo-path unit test also enumerates `git ls-files` and checks every tracked path and directory (`src/instructions/index.test.ts:32-48`); the spec asked only for the `docs/` and `.md` checks.
- The MCP resource carries a `title` and `description` (`src/mcp/server.ts:110-113`).

## 3. Tests: title vs body

- `e2e/agent-instructions.test.ts:9` "prints the agent instructions on stdout and exits 0 without starting a daemon": spec claim; body asserts exit 0, empty stderr, stdout equals `AGENT_INSTRUCTIONS`, no socket file. Proven.
- `e2e/agent-instructions.test.ts:22` "--json prints one JSON object whose instructions field equals the text output": spec claim; body asserts one line and `toEqual({ instructions: text.stdout })`. Proven.
- `e2e/agent-instructions.test.ts:33` "--bogus fails with USAGE and exit 2": spec claim; body asserts exit 2, empty stdout, error code `USAGE`. Proven.
- `e2e/mcp-session.test.ts:11` "declares the resources capability, lists simlock://instructions, and reading it returns the same text the CLI prints": spec claim; body asserts all three. Proven.
- `src/cli/index.test.ts:2867` "--help prints the command's usage instead of the instructions, exit 0": not a claim the spec made (spec: other flags are `USAGE` exit 2). Body proves the title. See finding 1.
- `src/cli/index.test.ts:2876` "a positional argument fails with USAGE and exit 2, printing nothing on stdout": not a claim the spec made. Body proves the title.
- `src/instructions/index.test.ts:28` "name no path inside this repository": spec claim; body asserts no `docs/`, no `.md`, and no tracked path or directory. Proven.
- `src/instructions/index.test.ts:51` "name every refused passthrough verb the drivers refuse": spec claim; body derives simctl and adb verb lists from exported driver constants and checks each appears on the matching refusal line. The option-before-subcommand refusals the text also states are not derived. See finding 5.

## Findings

- [note] `simlock instructions --help` and `-h` exit 0 with a usage line where the specification says any flag other than `--json` is `USAGE` (exit 2), and the added unit test enshrines that claim. Evidence: `src/cli/index.ts:886`, `src/cli/index.test.ts:2867`.
- [note] `docs/CLI.md` says "Any other flag or argument is a usage error (exit 2)", which the code in the same diff contradicts for `--help`/`-h` (architecture rule 13: a false doc claim is a defect). Evidence: `docs/CLI.md:863`.
- [note] The instructions text asserts CLI behaviours the specification did not list and no test in the diff checks against the CLI's actual contract: `--os`, `--timeout`, `--no-wait`, `--export-env`, `--lease <lease-id>` on the passthroughs, grant field names `lease.id` / `lease.ttlDeadline` / `device.driverDeviceId`, the stderr error JSON shape, and exit 13 covering both a held lease and a queued request. Evidence: `src/instructions/index.ts:26`, `src/instructions/index.ts:41`, `src/instructions/index.ts:44`, `src/instructions/index.ts:49`.
- [note] The instructions module, outside both driver modules, spells out driver-owned environment keys and their meaning (`SIMLOCK_IOS_DEVICE_SET` as the `--set` path, `ANDROID_ADB_SERVER_PORT` as a port) where the specification asked only that the text point at the `environment` block (architecture rule 2). Evidence: `src/instructions/index.ts:49`.
- [note] The test "name every refused passthrough verb the drivers refuse" derives the verb lists from driver constants, but the text's "any option before the subcommand" refusals, including the adb exemptions `-s`, `-t`, `-d`, `-e`, are hand-copied and not checked against the drivers, so a driver change there keeps the test green (testing rule 4). Evidence: `src/instructions/index.ts:53`, `src/instructions/index.test.ts:60`.
- [note] The diff changes iOS driver production code beyond exporting constants: it adds `REFUSED_RUNTIME_OPERATION` and rewrites the `runtime delete` check and its refusal message, while the specification's "Modules touched" names no driver. Evidence: `src/drivers/ios/index.ts:104`, `src/drivers/ios/index.ts:1286`.
- [note] `pnpm check` green is a Done-when line this review could not verify; it was not run. Evidence: n/a.

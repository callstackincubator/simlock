# End-to-end suite

Deterministic end-to-end tests that run the **real** processes — a spawned
daemon, the CLI as a subprocess, the MCP server driven by a real
`@modelcontextprotocol/sdk` client — over a real unix socket.

Unit tests (`src/**/*.test.ts`) already cover the core's logic in-process. These
flows only assert what crosses a process boundary: exit codes, the structured
stderr contract, MCP framing and notifications, daemon restarts, `kill -9`
recovery. Anything provable in-process belongs in a unit test instead.

## Lanes

| Lane | Command                  | What it uses                      | Where it runs          |
| ---- | ------------------------ | --------------------------------- | ---------------------- |
| fast | `pnpm run test:e2e`      | scriptable fake driver, no SDKs   | every `pnpm run check` |
| slow | `pnpm run test:e2e:slow` | real `simctl` / `adb` / emulators | manual, pre-release    |

The slow flows are tagged `slow` plus `ios`/`android`, so the fast lane excludes
them with `--tags-filter='!slow'`. Each also gates itself at runtime with
`describe.skipIf` on platform and SDK availability. Filter further with, for
example, `pnpm exec vitest run --project e2e --tags-filter='ios && !android'`.

The fast lane runs four files at once: each flow has its own `SIMLOCK_HOME`, so
nothing on disk or on a socket is shared. The slow lane runs one file at a time
(`--no-file-parallelism`), because its flows share the machine's real simulators
and emulators.

## How isolation works

Each `withDaemon()` allocates a temp `SIMLOCK_HOME` (so config, state, socket and
log are per-test) and, in the fast lane, points `SIMLOCK_DRIVERS_MODULE` at
`e2e/fake-driver` — the daemon then talks to a scripted driver instead of real
hardware without knowing the difference. Both variables are documented in
[../docs/CLI.md](../docs/CLI.md#environment-variables).

The fake driver reads a JSON script file, re-read on every call so a test can
change behaviour mid-flight, and appends every call it receives to a log file.
Assertions like "`doctor --fix` never destroyed a device" or "a missing runtime
never triggered a download" read that log.

## Writing a flow

- Build on the helpers in `helpers/`; no flow should reimplement process
  spawning, polling, or output parsing.
- `waitFor` is the only timing primitive. **Never sleep for a fixed duration.**
- Prefer one fat flow that exercises several features over many small tests —
  the point is confidence in a release, not branch coverage.
- Never weaken an assertion to get green. If a flow trips a real bug, mark that
  assertion (`it.fails`) with a comment naming the suspected cause.

Hooks must be registered at module scope. Vitest resolves `beforeEach`/`afterEach`
from the call stack active during _collection_, so a hook registered from inside a
running test body silently never fires — see the comment in `helpers/env.ts`.

## Known gaps

- **The slow lane does not pass reliably as a whole run.** A daemon
  occasionally outlives `daemon stop` and trips teardown's stray-process
  assertion; not yet root-caused, and not yet distinguished from the reclaim
  stall recorded in [../docs/internal/KNOWN-PITFALLS.md](../docs/internal/KNOWN-PITFALLS.md).
  The slim lane also fails while a 50-label disable batch can outrun its fixed
  60s limit on a cold boot ([#206](https://github.com/callstackincubator/simlock/issues/206)). Treat the slow lane as a manual,
  one-flow-at-a-time tool until both are fixed.
- `daemon status` ignores `--json` and always prints raw JSON; documented by an
  `it.fails` in `daemon-lifecycle.test.ts`.
- Android is exercised through the fake driver in the fast lane; only
  `slow-android-smoke.test.ts` touches a real emulator.

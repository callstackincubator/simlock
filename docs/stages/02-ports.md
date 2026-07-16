# Stage 02 — Ports (external-API interfaces)

Goal: every external API behind an injected interface, with real Node
adapters and in-memory fakes, per ARCHITECTURE.md "External APIs behind
interfaces" and agent-rules/architecture.md rule 9. After this stage, no
other module may ever import `node:fs`, `node:child_process`, `node:os`, or
call `Date.now()`/`setTimeout` directly.

## Interfaces (in `src/ports/`)

- `Filesystem` — readFile, writeFileAtomic (temp + rename), mkdirp, rm, stat,
  readdir, exists, diskFree(path).
- `ProcessRunner` — `run(cmd, args, {timeoutMs, env, cwd})` → `{code, stdout,
stderr}`; `spawn(...)` → handle with pid, kill(signal), wait(), and
  stdout/stderr line streams (needed for long-running `emulator` processes).
- `Clock` — `now(): number`; `setTimer(ms, fn): TimerHandle`;
  `cancel(handle)`. All time logic in the app goes through this.
- `SystemStats` — cpuCount, totalRamBytes, freeRamBytes.

## Fakes (also in `src/ports/`, exported for tests)

- `MemoryFilesystem` — path-keyed map, configurable diskFree.
- `ScriptedProcessRunner` — FIFO/pattern-matched expectations: each expected
  invocation declares matcher (cmd + args) and scripted result (or streamed
  lines, or hang-until-killed). Unexpected invocations throw. Exposes a log
  of all calls for assertions.
- `FakeClock` — manual `advance(ms)` fires due timers deterministically.
- `FakeSystemStats` — fixed values.

## Tests first

- **Contract tests** written once, run against both implementations where
  feasible: Filesystem contract runs against `MemoryFilesystem` and the real
  adapter in a temp dir (atomicity: writeFileAtomic never leaves partial
  files; overwrite semantics; mkdirp idempotence).
- FakeClock: timers fire in order on advance; cancelled timers don't fire;
  timer set during advance for an already-passed deadline fires.
- ScriptedProcessRunner: matching, unexpected-call throws, kill on a hanging
  spawn resolves wait().
- Real ProcessRunner: run `node -e` snippets (echo stdout/stderr, exit codes,
  timeout kills the process).

## Watch out

- `writeFileAtomic` must rename within the same directory (cross-device
  rename fails); fsync is nice-to-have, not required.
- ProcessRunner timeout must kill the whole process group on POSIX
  (`detached: true` + negative-pid kill) or long-running emulators leak.
- Keep interfaces minimal — add methods when a later stage needs them, not
  speculatively.

## Acceptance criteria

- [ ] All four ports + real adapters + fakes exist and are exported from
      `src/ports/`.
- [ ] Filesystem contract suite passes against memory AND real adapters.
- [ ] `grep -r "node:fs\|node:child_process\|Date.now\|setTimeout" src/`
      matches only inside `src/ports/` (and tests).
- [ ] `pnpm check` green.

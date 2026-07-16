# Stage 11 — iOS driver (simctl)

Goal: the real iOS driver behind the stage-06 interface, tested entirely with
`ScriptedProcessRunner` replaying recorded `simctl` output. Zero core changes
allowed (architecture rule 3 — if you need one, the interface leaked; stop
and flag it).

## Implement (in `src/drivers/ios/`)

- **resolveSpec**: `xcrun simctl list -j devicetypes runtimes` → match model
  (exact name, case-insensitive) → `UnknownModelError`; osVersion match or
  default = newest _installed_ runtime; requested-but-not-installed →
  `RuntimeMissingError` (runtime download is NOT implemented in v1 even with
  `--allow-download` — return a clear "install via Xcode" message; note this
  deviation in CLI.md when integrating).
- **provision**: `simctl create "pitlane-<id>" <deviceTypeId> <runtimeId>` →
  UDID into `driverData` (name prefix `pitlane-` is load-bearing for doctor).
- **makeReady**: `simctl boot <udid>` then `simctl bootstatus <udid> -b` via
  ProcessRunner with a **generous timeout (120s — benchmark saw ~30s ±30%
  variance and a 64s first-boot tax)** → `BootTimeoutError` on expiry (and
  best-effort `shutdown`).
- **reclaim**: `simctl shutdown <udid>` (tolerate "already shutdown") +
  `simctl erase <udid>` → return `'shutdown'` (core decides on re-boot;
  benchmark: erase ≈ 0.3s). `clean: 'full'` and `'standard'` are identical
  on iOS.
- **shutdown** / **destroy**: `simctl shutdown` / `simctl delete`
  (destroy on a booted device: shutdown first).
- **estimate**: constants from the benchmark — provision 500ms, boot 30s,
  reclaim 1s.

## Tests first

- Fixtures: commit real (sanitized) `simctl list -j` output under
  `src/drivers/ios/fixtures/`. Get it from `xcrun simctl list -j devicetypes
runtimes` on this machine.
- resolveSpec: model found / unknown model / runtime default = newest
  installed / missing runtime error / case-insensitive match.
- provision: correct argv (assert exact args incl. `pitlane-` prefix);
  simctl non-zero exit → DriverCrashError with stderr in message.
- makeReady: happy path argv sequence; bootstatus hang → BootTimeoutError
  after FakeClock advance + best-effort shutdown issued.
- reclaim: shutdown+erase sequence; "Unable to shutdown ... current state:
  Shutdown" stderr tolerated.
- **Live smoke test** (skipped unless `PITLANE_LIVE_IOS=1`): full
  provision→ready→reclaim→destroy cycle against real simctl with a
  `pitlane-test-` device; must clean up in `finally`.

## Watch out

- Parse `simctl` JSON defensively — runtime identifiers differ between Xcode
  versions (`com.apple.CoreSimulator.SimRuntime.iOS-26-5`); match on the
  `version`/`name` fields, not string-splitting identifiers.
- All invocations via ProcessRunner with explicit timeouts — no un-timeouted
  waits.
- `driverData` shape: `{udid, deviceTypeId, runtimeId, name}` — never leaks
  into core types.

## Acceptance criteria

- [ ] Full Driver interface implemented; compiles against stage-06 types
      with no core edits.
- [ ] All scripted tests green; argv assertions exact.
- [ ] Live smoke test passes on this machine with `PITLANE_LIVE_IOS=1`
      (run it once; report the result) and cleans up after itself.
- [ ] `pnpm check` green.

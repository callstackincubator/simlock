# Stage 12 — Android driver (avdmanager / emulator / adb)

Goal: the real Android driver — the harder one: AVD creation, headless
emulator boot, port allocation, quickboot snapshots with config-hash
invalidation detection. All tests scripted via ScriptedProcessRunner; zero
core changes allowed.

## Implement (in `src/drivers/android/`)

- **SDK discovery**: `ANDROID_HOME` → `ANDROID_SDK_ROOT` →
  `~/Library/Android/sdk`; resolve `avdmanager`, `emulator`, `adb` binaries;
  missing SDK → typed `SdkMissingError` at driver construction (daemon
  registers the driver only if construction succeeds).
- **resolveSpec**: enumerate installed system images from the
  `system-images/` directory tree (API level, tag e.g. `google_apis`, ABI —
  prefer host ABI). Model maps to an avdmanager device profile
  (`avdmanager list device`); osVersion = API level, default newest
  installed. Missing image → `RuntimeMissingError`; with `allowDownload` →
  `sdkmanager --install 'system-images;android-<api>;google_apis;<abi>'`
  (long timeout, progress via estimate).
- **provision**: `avdmanager create avd -n pitlane_<id> ...` →
  `driverData: {avdName, configHash, port?, serial?}`. `configHash` = hash of
  (system image path+version, emulator version from `emulator -version`,
  relevant AVD config.ini keys) — the snapshot-invalidation tag.
- **makeReady**: allocate an even console port (5554–5682) by probing
  `adb devices` + tracked in driverData; launch via ProcessRunner.spawn:
  `emulator -avd <name> -port <p> -no-window -no-audio -no-boot-anim`
  (+ `-no-snapshot-load` for a `clean: 'full'` boot). Readiness poll (Clock
  timers, every 2s, timeout 180s): `adb -s emulator-<p> shell getprop
sys.boot_completed` == 1 AND bootanim stopped **or unset** (the property
  never appears under `-no-boot-anim` — see known benchmark finding).
- **reclaim**: standard = quit cleanly (`adb emu kill`, wait for process
  exit) so quickboot saves, verify configHash still valid → `'shutdown'`
  (next makeReady restores in ~4s). Stale configHash → also delete snapshot
  dir and mark for `-wipe-data` on next boot. `clean: 'full'` = kill +
  next boot gets `-wipe-data -no-snapshot-load`.
- **Cold-boot fallback detection**: after a snapshot-expected boot, if
  time-to-ready exceeded ~3× the snapshot estimate, emit a driver log/flag
  (silent invalidation happened) — recompute configHash.
- **shutdown**: `adb emu kill` + wait + verify process exit (kill -9 the
  spawn handle on timeout). **destroy**: shutdown + `avdmanager delete avd`.
- **estimate**: provision 1s (create) / minutes if downloading; boot 31s
  cold, 4s snapshot; reclaim 2s.

## Tests first

- Fixtures: `avdmanager list device`, system-images directory listing shapes,
  `adb devices` outputs, getprop responses.
- SDK discovery order + SdkMissingError.
- resolveSpec: image matching incl. ABI preference; RuntimeMissingError;
  allowDownload triggers sdkmanager with exact argv.
- Port allocation: skips ports present in `adb devices`; concurrent
  provisions get distinct ports (two drivers sharing one scripted runner).
- Readiness: boot_completed=1 + bootanim UNSET → ready (the -no-boot-anim
  case); poll timeout → BootTimeoutError + process killed.
- reclaim standard: adb emu kill argv + process-exit wait; configHash
  mismatch path deletes snapshot + flags wipe.
- Full-clean boot argv includes `-wipe-data -no-snapshot-load`.
- **Live smoke test** (skipped unless `PITLANE_LIVE_ANDROID=1`): one
  provision→ready→reclaim→re-ready (assert snapshot boot is materially
  faster)→destroy cycle; cleans up in `finally`.

## Watch out

- The emulator is a long-running spawn, not a run — hold the handle in
  driverData/driver state; on daemon crash recovery doctor (stage 13) finds
  orphans by process listing, so name AVDs `pitlane_` consistently.
- `adb emu kill` returns before the process exits — always wait on the spawn
  handle too.
- Never run two emulator commands for the same AVD concurrently; serialize
  per-device inside the driver.

## Acceptance criteria

- [ ] Full Driver interface implemented, no core edits.
- [ ] Scripted tests green incl. port allocation, bootanim-unset readiness,
      configHash invalidation.
- [ ] Live smoke test passes with `PITLANE_LIVE_ANDROID=1` (run once, report)
      and cleans up.
- [ ] `pnpm check` green.

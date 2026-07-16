# Stage 13 — Doctor, nuke & end-to-end

Goal: reconcile-with-reality tooling, the last stubbed CLI commands, and the
flagship end-to-end proof that pitlane does its job.

## Implement

- **Doctor** (`src/core/` logic + driver support): compare registry against
  reality — each driver gets a `listManaged(): Promise<DriverDevice[]>`
  addition ONLY if unavoidable; prefer deriving from existing verbs, else
  add it to the interface in this stage with fake-driver support + note in
  ARCHITECTURE.md. Findings: registry device missing on disk; `pitlane-`/
  `pitlane_`-named device on disk missing from registry (orphan); emulator
  process with no registry entry; expired-but-live lease. `--fix`: safe
  corrections only (mark vanished devices deleted, adopt-or-destroy orphans
  bearing our prefix, kill orphan processes we can attribute). Emit
  `doctor.reconciled`. Run the read-only pass on daemon startup.
- **Nuke**: force-release all leases → kill pitlane-attributable processes →
  clear queue → (`--delete-devices`) destroy all registry devices. Registry-
  only destruction throughout (safety rule 1).
- **Runtime GC** (T3, explicit-only): `cleanup --rule runtime-gc` — iOS: none
  in v1 (runtimes are Xcode-managed; document). Android: delete system
  images unreferenced by any registry AVD — proposal-based like every rule.
- Wire real drivers into daemon startup (construct ios always on darwin,
  android if SDK found; log what registered).
- Unstub CLI `doctor` / `nuke` (stage 10 left them erroring).
- **Flagship e2e test** (FakeDriver, in-process daemon, real CLI code paths):
  capacity 1; agent A leases → agent B requests same spec and queues →
  A's connection drops → B gets the device. This is the tool's reason to
  exist; it must be a test.
- **Live e2e** (gated `PITLANE_LIVE_IOS=1`): the same scenario through the
  real built CLI binary against a real daemon with the real iOS driver.
- Docs sync: EVENTS.md statuses → implemented; CLI.md — remove stub notes,
  document the iOS `--allow-download` limitation; README.md quickstart at
  repo root; stages README all `done`.

## Tests first

- Doctor findings: each drift class detected from synthetic registry +
  scripted driver/process reality; `--fix` corrects exactly the safe set;
  never proposes touching a non-prefixed device (safety rule 1 test).
- Nuke: leaves non-registry devices untouched (scripted runner asserts no
  argv targets them); `--delete-devices` destroys all registry devices.
- Flagship e2e as above, plus: B times out if A never releases; two
  same-requester connections rejected.

## Watch out

- Doctor `--fix` must be idempotent — running twice changes nothing the
  second time (test it).
- Adopt-vs-destroy for orphans bearing our prefix: v1 destroys (simpler,
  safe — it's ours by prefix); note adoption as an IDEAS.md item if skipped.
- This stage closes v1: sweep all `TODO(stage-NN)` markers in the codebase;
  none may remain.

## Acceptance criteria

- [ ] Flagship contention e2e green in CI-mode (fakes); live variant run
      once on this machine and reported.
- [ ] Doctor detects all four drift classes; --fix safe + idempotent.
- [ ] Nuke provably registry-only.
- [ ] All CLI.md commands implemented; docs synced; zero TODO(stage-*) left.
- [ ] `pnpm check` green.

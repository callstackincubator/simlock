# Agent rules: toolchain

This project's commands and project-only checks. Agents and skills name no
command of their own: they take every command from here.

## Tests agents run

| What                                           | Command                                      |
| ---------------------------------------------- | -------------------------------------------- |
| Unit tests that import what the branch changed | `pnpm test:changed`                          |
| One unit test file                             | `pnpm exec vitest run --project unit <file>` |
| One timing file (`*.timing.test.ts`)           | `pnpm exec vitest run --project timing <file>` |
| Fast e2e files (builds first)                  | `pnpm test:e2e <files>`                      |
| Console lane, Chromium only (1)                | `pnpm test:console --project=chromium`       |
| Website build and its HTTP API check (2)       | `pnpm --dir website install && pnpm --dir website build && node website/scripts/check-openapi.mjs` |

(1) Only when the diff touches `ui/`, `e2e/console/`, `src/http/` or
`src/contract/`.

(2) Only when the diff touches `website/`, `src/http/`, `src/contract/`,
`src/modules/` or a module's `definition.ts`.

## Checks agents never run

Hooks and CI run these. Never run them by hand, and never the tools behind
them (from `node_modules/.bin` or any other path): `pnpm check`, `pnpm test`,
`pnpm test:timing`, `pnpm typecheck`, `pnpm typecheck:e2e`, `pnpm typecheck:e2e:types`, `pnpm lint`, `pnpm lint:comments`,
`pnpm format`, `pnpm format:check`,
`pnpm fallow`, `pnpm mutate` (outside the `harden-tests` routine), the whole
e2e suite, the console lane in every browser (`pnpm test:console`), `tsc`,
`oxlint`, `depcruise`, `oxfmt`, `fallow`, `stryker`, `.agents/scripts/comment-lint.mjs`
(outside the `garden-comments` routine). A PreToolUse hook
(`.agents/scripts/tool-guard.mjs`) refuses them in every sub-agent; keep its
list and this one the same.

- **Commit hook:** formats the staged files and stages the result, then
  lint, the comment lint (architecture rule 17) and typecheck. Errors show
  in its output.
- **Push hook:** Fallow, then the e2e typecheck.
- **CI:** what `pnpm check` runs, and Fallow, on every push. The `pnpm
  check` steps run as parallel jobs (static checks, unit tests, the timing
  tests, the e2e lane in three shards); the Quality check passes only when all of them
  do. The console lane runs on
  every push to `main`, and on a pull request when it changes a source, UI,
  console spec or build file: in every browser when it changes `ui/` or the
  console specs, else in Chromium only.

## Mutation testing

Not part of delivery. The weekly `harden-tests` routine runs `pnpm mutate
<base> --max-lines 1500` on `main` for the source lines changed since
`<base>`, newest files first up to that many lines, kills the survivors that
change behaviour a caller or user can see, and opens one tests-only PR. The
script first runs only the test files that import a changed file, or reach
it through their own module's `index.ts`, or that the branch changed; a
mutant those leave alive gets a second run with every related test file.

## Routines

Claude Code routines run these skills on a schedule, each but one opening
one PR that goes through the reviews its diff's kind gets and the merge
gate:

| Routine            | Skill               | When   |
| ------------------ | ------------------- | ------ |
| Test hardening     | `harden-tests`      | weekly |
| Test audit         | `audit-tests`       | weekly |
| Comment gardening  | `garden-comments`   | weekly |
| Review calibration | `calibrate-reviews` | weekly |
| Recurring findings | `recurring-findings` | weekly |

`recurring-findings` opens draft task issues instead of a PR, and skips
the ending below. Every other routine ends the same way; its skill adds
only what it changes:

1. `reviewer` with the PR number, round 1. Fix each Fix line yourself,
   within the routine's kind of edit, then the check its `Rerun` names:
   `reviewer` with that round, `previous <Commit>` and the complete
   resolution ledger. `Rerun: none` with findings open: leave the PR in
   draft and report them.
2. Add the `## Review` section as the `deliver` skill's step 4 shapes it,
   `skipped` for each review the diff's kind left out.
3. `gh pr ready <M>`, then `.agents/scripts/merge-pr.sh <M>`. Anything but
   a merge: leave the PR open and report.

In a cloud session, edit a PR body with
`gh api -X PATCH repos/<owner>/<repo>/pulls/<M> -F body=@<file>`
(`gh pr edit` is GraphQL, which the cloud refuses), and when `gh pr ready`
fails with a 403 naming the proxy's ready-for-review route, call that route.

## The real-proxy lane

`pnpm test:real-proxy` runs Simlock behind oauth2-proxy and Dex (both in
Docker, host networking) and signs a person in through them in Chromium. Linux
with Docker only; agents never run it, CI does (the "Real proxy" workflow, on a
pull request that changes source, and weekly). One run per machine: ports 4180,
5556 and 4700 are fixed, and the setup fails naming one that is busy.

## The screen capture programs

`pnpm build` runs `scripts/build-capture.mjs`: it copies the vendored scrcpy
server into `dist/vendor/scrcpy/` after checking its pinned SHA-256, and on a
Mac with Xcode selected it builds `vendor/screen-capture/` (Swift) into
`dist/bin/simlock-screen-capture` and `dist/bin/simlock-device-capture`, one
product per `swift build`, each whether or not the other built. Elsewhere the
Swift build is skipped and iOS streams report unavailable. Neither build checks
a CoreDevice version: the device program is the one place that enforces that
pin.

Neither runs in the unit, e2e or console lanes: both read a booted device's
screen, which means real devices and the slow lane. The lanes cover what this
repo writes -- the stream module, the drivers' capture code against fakes, the
envelope -- and the console lane runs a stand-in program that writes the same
envelope from stills (`e2e/console/screen-capture.ts`), named by the fake
driver's `screenCaptureCommand`. A change to the Swift program is checked by
hand on a machine with a simulator, where
`node vendor/screen-capture/scripts/unframe.mjs <capture> out.264` turns the
bytes it wrote into Annex-B and counts each tag, and `ffprobe out.264` says
whether they decode.

## Slow lane

Tests that start real simulators or emulators. Run them only through
`scripts/slow-e2e.sh <test files>`:

- It holds a machine-wide lock, runs detached, prints its log path at once,
  and writes `<log>.exit` when the run ends.
- Exit 75: another run holds the lock; the script prints the holder.
- Exit 69: the machine is unfit (low disk, another tool at the
  wrong version or not built); the script prints why.
- Vitest arguments pass through: `-t "<title>"` runs one test, `--bail=1`
  ends the run at the first failure.
- It first stops what earlier runs left behind. By hand: `scripts/slow-e2e.sh
  clean` (refused while a run holds the lock). Never stop a simulator,
  emulator or daemon any other way.
- `scripts/slow-e2e.sh status`: the running test, the counts so far, how
  long the log has been quiet, and each failure. `scripts/slow-e2e.sh stop`
  ends the running lane and what it started.
- This machine's settings live in `.slow-lane.env` at the main checkout's
  root (untracked): `SIMLOCK_E2E_AGENT_DEVICE=<path>` and any other
  variable below. The script reads it; nobody passes them by hand.

The machine can run a line only if:

| Line needs | Check                                                      |
| ---------- | ---------------------------------------------------------- |
| iOS        | `uname -s` is `Darwin`; `xcrun simctl list runtimes` lists one |
| Android    | `command -v emulator adb` finds both                       |
| Physical iOS | `uname -s` is `Darwin`; `SIMLOCK_PHYSICAL_IOS` is the UDID of an iPhone on USB (trusted, Developer Mode on, unlocked, Auto-Lock Never); `SIMLOCK_PHYSICAL_IOS_APP` is a `.app` signed for it. `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Library/Developer/PrivateFrameworks/CoreDevice.framework/Resources/Info.plist` prints `642.` followed by a number (streaming a phone needs Xcode 27's CoreDevice; the framework is machine-wide and does not follow `xcode-select`). DeviceHub and Xcode are not running during the lane. The stream cases need the iPhone on iOS 27 or later; an older iPhone runs the refusal case instead. Run `scripts/slow-e2e.sh --physical e2e/slow-ios-physical.test.ts` |
| agent-device through simlock | `node -v` is 22.12.0 or later (agent-device's own minimum); the iOS check and `uname -m` is `arm64` (the fixture app is arm64 only), or the Android check; `SIMLOCK_E2E_AGENT_DEVICE` (in `.slow-lane.env`) is the absolute path of `bin/agent-device.mjs` in an install of the agent-device version `package.json` pins for `@agent-device/proxy` (`npm install -g agent-device@<version>`, or a checkout at tag `v<version>` built with `pnpm install && pnpm build && pnpm build:android`, the last building the Android snapshot helper); room for two devices: `node -p "os.totalmem() / 2**30"` prints at least 7 for iOS or 12 for Android (simlock's 4 GiB OS reserve plus two of its default 1.5 GiB iOS or 4 GiB Android per-device budgets). Run `scripts/slow-e2e.sh e2e/slow-agent-device.test.ts` or `scripts/slow-e2e.sh e2e/slow-agent-device-gateway.test.ts` |
| Physical Android | `command -v adb` finds it; `adb devices -l` lists `$SIMLOCK_PHYSICAL_ANDROID` on a USB transport (a `usb:` field) in state `device`; `SIMLOCK_PHYSICAL_ANDROID_APK` names an APK. Run `scripts/slow-e2e.sh --physical e2e/slow-android-physical.test.ts` |
| Physical Android, a person at the phone | the Physical Android checks above, and `SIMLOCK_PHYSICAL_PERSON` is `1`. Run `scripts/slow-e2e.sh --physical-manual e2e/slow-android-physical-manual.test.ts` |
| Physical iOS, a person at the phone | the Physical iOS checks above, a passcode set on the phone (locking it then needs the passcode), and `SIMLOCK_PHYSICAL_PERSON` is `1`. Run `scripts/slow-e2e.sh --physical-manual e2e/slow-ios-physical-manual.test.ts` |

Two tags mark the phone lane. `physical` tests run unattended. `physical-manual`
tests prompt a person in the log and wait up to 150 s for each step. Only a
person running the lane by hand sets `SIMLOCK_PHYSICAL_PERSON`. The hardware
verifier never does, so the second machine check fails and it reports
`unavailable (needs a person)`.

A Done when line needs the slow lane when it needs a real simulator or
emulator. It says so in its own words ("on a Mac with an iOS runtime: ...")
and names the slow-lane test that proves it.

## Other tools' source

A spec's Facts row about another tool cites that tool's source at the
version this repo uses, or a command run on this machine; never a summary or
the tool's docs alone.

| Tool | Version | Read it |
| ---- | ------- | ------- |
| agent-device | the version `package.json` pins for `@agent-device/proxy` (tag `v<version>`) | `git -C <checkout> show v<version>:<path>` in a clone of `callstack/agent-device` (on a machine that runs the slow lane, the one `.slow-lane.env` names). No clone: `gh api 'repos/callstack/agent-device/contents/<path>?ref=v<version>' -H 'Accept: application/vnd.github.raw'`. The proxy as simlock bundles it: `node_modules/@agent-device/proxy/dist` |
| Android SDK tools, Xcode tools | the installed ones | run them: `<tool> --help`, or the command itself |
| simlock's own CLI | `main` | `pnpm build`, then `node dist/cli/main.js <command> --help` or the command itself |

## Project checks

- **Strict test areas** (testing rule 3): `src/leasing/`; in `src/core/`,
  the registry and its lock (`registry.ts`, `serialized-decision.ts`,
  `device-operation-claims.ts`), reclaim, quarantine and destruction
  (`reclaim-coordinator.ts`, `quarantine-coordinator.ts`, `reaper.ts`,
  `cleanup/`, `cleanup-executor.ts`, `nuke.ts`, `nuke-service.ts`,
  `managed-device-lifecycle.ts`), ownership (`device-root.ts`,
  `physical-enrollment.ts`) and startup (`startup-converger.ts`); and the
  validators of wire input in `src/contract/` (safety rule 10).

- **Published surfaces.** A change to a schema, a contract type or a
  validator reruns the tests of every surface that publishes it: MCP
  `tools/list`, HTTP error bodies, CLI help. A refinement can empty a
  published schema while every unit test stays green.
- **Contract shapes.** Every change to a contract shape bumps
  `DAEMON_PROTOCOL_VERSION` by one in the same PR (a spec's "protocol +1 at
  merge" means this too), so two tasks that change contract shapes
  overlap even when they touch different files. The push hook and CI run
  `.agents/scripts/protocol-bump-check.mjs`: a contract shape change with
  no bump, or a bump with no shape change, fails. A contract edit that
  changes no wire shape (a refactor, a client-only error code) carries the
  commit trailer `Protocol-bump: none (<reason>)`.

## Review measurement

Every prompt a delivery stage or review lens is started with begins with
this line, `-` for a key that does not apply yet:

```
ledger: pr=<M> issue=<N> stage=<build|audit|fix|hardware-fix|review|hardware> round=<1|2|fix-check> role=<implementer|reviewer|spec|code|claims|hardware-verifier> lens=<behaviour|tests|both>
```

`node .agents/scripts/review-metrics.mjs --pr <M> --issue <N> [--findings
<file>]` reads the runs so tagged from Claude Code's transcripts on this
machine and prints their models, seconds, tokens and cost, and with
`--findings` the outcome and class counts; [REVIEW.md](../REVIEW.md) says
what goes in the findings file and where the result is posted. It reports,
it checks nothing. Runs tagged `stage=replay` (a frozen snapshot reviewed
again by `review-replay.sh`) are left out unless `--replay` is given.

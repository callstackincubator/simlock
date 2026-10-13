# Agent rules: toolchain

This project's commands and project-only checks. Agents and skills name no
command of their own: they take every command from here.

## Tests agents run

| What                                           | Command                                      |
| ---------------------------------------------- | -------------------------------------------- |
| Unit tests that import what the branch changed | `pnpm test:changed`                          |
| One unit test file                             | `pnpm exec vitest run --project unit <file>` |
| Fast e2e files (builds first)                  | `pnpm test:e2e <files>`                      |
| Console lane, Chromium only (1)                | `pnpm test:console --project=chromium`       |

(1) Only when the diff touches `ui/`, `e2e/console/`, `src/http/` or
`src/contract/`.

## Checks agents never run

Hooks and CI run these. Never run them by hand, and never the tools behind
them (from `node_modules/.bin` or any other path): `pnpm check`, `pnpm test`,
`pnpm typecheck`, `pnpm typecheck:e2e`, `pnpm lint`, `pnpm lint:comments`,
`pnpm format`, `pnpm format:check`,
`pnpm fallow`, `pnpm mutate` (outside the `harden-tests` routine), the whole
e2e suite, the console lane in every browser (`pnpm test:console`), `tsc`,
`oxlint`, `oxfmt`, `fallow`, `stryker`, `.agents/scripts/comment-lint.mjs`
(outside the `garden-comments` routine). A PreToolUse hook
(`.agents/scripts/tool-guard.mjs`) refuses them in every sub-agent; keep its
list and this one the same.

- **Commit hook:** formats the staged files and stages the result, then
  lint, the comment lint (architecture rule 17) and typecheck. Errors show
  in its output.
- **Push hook:** Fallow, then the e2e typecheck.
- **CI:** what `pnpm check` runs, and Fallow, on every push. The `pnpm
  check` steps run as parallel jobs (static checks, unit tests, the e2e
  lane in three shards); the Quality check passes only when all of them
  do. The console lane runs on
  every push to `main`, and on a pull request when it changes a source, UI,
  console spec or build file: in every browser when it changes `ui/` or the
  console specs, else in Chromium only.

## Mutation testing

Not part of delivery. The weekly `harden-tests` routine runs
`pnpm mutate <base> --max-lines 1500` on `main` for the source lines
changed since `<base>`, newest files first up to that many lines, kills
the survivors that change behaviour a caller or user can see, and opens
one tests-only PR.

## Routines

Claude Code routines run these skills on a schedule, each opening one PR
that goes through the reviews its diff's kind gets and the merge gate:

| Routine            | Skill               | When   |
| ------------------ | ------------------- | ------ |
| Test hardening     | `harden-tests`      | weekly |
| Comment gardening  | `garden-comments`   | weekly |
| Review calibration | `calibrate-reviews` | weekly |

## Slow lane

Tests that start real simulators or emulators. Run them only through
`scripts/slow-e2e.sh <test files>`:

- It holds a machine-wide lock, runs detached, prints its log path at once,
  and writes `<log>.exit` when the run ends.
- Exit 75: another run holds the lock; the script prints the holder.

The machine can run a line only if:

| Line needs | Check                                                      |
| ---------- | ---------------------------------------------------------- |
| iOS        | `uname -s` is `Darwin`; `xcrun simctl list runtimes` lists one |
| Android    | `command -v emulator adb` finds both                       |
| Physical iOS | `uname -s` is `Darwin`; `SIMLOCK_PHYSICAL_IOS` is the UDID of an iPhone on USB (trusted, Developer Mode on, unlocked, Auto-Lock Never); `SIMLOCK_PHYSICAL_IOS_APP` is a `.app` signed for it. Run `scripts/slow-e2e.sh --physical e2e/slow-ios-physical.test.ts` |
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

## Project checks

- **Published surfaces.** A change to a schema, a contract type or a
  validator reruns the tests of every surface that publishes it: MCP
  `tools/list`, HTTP error bodies, CLI help. A refinement can empty a
  published schema while every unit test stays green.
- **Contract shapes.** Every change to a contract shape bumps
  `DAEMON_PROTOCOL_VERSION` by one in the same PR (a spec's "protocol +1 at
  merge" means this too), so two tasks that change contract shapes
  overlap even when they touch different files.

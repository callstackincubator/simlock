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
`pnpm typecheck`, `pnpm lint`, `pnpm lint:comments`, `pnpm format:check`,
`pnpm fallow`, `pnpm mutate` (outside the `harden-tests` routine), the whole
e2e suite, the console lane in every browser (`pnpm test:console`), `tsc`,
`oxlint`, `oxfmt`, `fallow`, `stryker`, `.agents/scripts/comment-lint.mjs`
(outside the `garden-comments` routine).

- **Commit hook:** formats the staged files and stages the result, then
  lint, the comment lint (architecture rule 17) and typecheck. Errors show
  in its output.
- **Push hook:** Fallow, then the e2e typecheck.
- **CI:** `pnpm check` and Fallow on every push. The console lane runs on
  every push to `main`, and on a pull request when it changes a source, UI,
  console spec or build file: in every browser when it changes `ui/` or the
  console specs, else in Chromium only.

## Mutation testing

Not part of delivery. The weekly `harden-tests` routine runs
`pnpm mutate <base>` on `main` for the source lines changed since `<base>`,
kills the survivors that change behaviour a caller or user can see, and
opens one tests-only PR.

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

A Done when line needs the slow lane when it needs a real simulator or
emulator. It says so in its own words ("on a Mac with an iOS runtime: ...")
and names the slow-lane test that proves it.

## Project checks

- **Published surfaces.** A change to a schema, a contract type or a
  validator reruns the tests of every surface that publishes it: MCP
  `tools/list`, HTTP error bodies, CLI help. A refinement can empty a
  published schema while every unit test stays green.
- **Contract shapes.** Every change to a contract shape bumps
  `DAEMON_PROTOCOL_VERSION` by one, so two tasks that change contract shapes
  overlap even when they touch different files.

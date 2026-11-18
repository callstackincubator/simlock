# Test support

Does: test-only helpers shared across modules; excluded from the build.

## Rules

- `imports.ts` is the one import scanner: static, side-effect, re-export and dynamic imports,
  comments stripped, specifiers normalized to `src/`. A boundary test uses it; it does not parse
  imports by itself.
- A repo-wide grep over source runs on `blankSource` output: it blanks comments (and with
  `strings`, string and template text) and keeps every newline, so a match is code, at the
  right line.
- `windows-skipped.ts` is the one list of test files the Windows CI job leaves out (ADR 0087);
  it is read on a Windows host only and only shrinks.
- `fake-command.ts` is how a test puts a fake `gh`, `pnpm` or `tsc` on PATH: `writeFakeCommand`
  writes it, `fakeCommandEnv` makes a spawned script find it first, and `BASH` is the bash a test
  starts a `.sh` script with. Windows starts only `.exe` files from a spawn, so there each fake
  also gets a copy of node's binary that runs the script.
- `promiseState` reads whether a promise settled without awaiting it, so a broken timer fails
  on an assertion, not a test timeout.

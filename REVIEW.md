# Code review: task/147 (`simlock instructions` + `simlock://instructions`)

Baseline: `pnpm check` passes typecheck, typecheck:e2e, lint, format, and the unit lane (1862 passed). Every changed code path went red under mutation: dropping the positional guard, the `--help` branch, the `--json` branch, the `instructions` dispatch arm, the MCP resource registration, and the resource text each failed a named assertion; removing a refused verb or adding a tracked path/directory to the text failed the instructions unit tests. No blocking findings.

- [note] Two clauses of the refusal lines are prose no test pins, so a driver change to adb's allowed globals or to simctl's "refuse every option" scan leaves the printed instructions stale with a green suite (testing rule 4; architecture rule 13). The test `name every refused passthrough verb the drivers refuse` reads only the exported constants, not `allowedGlobalArity` or `#subcommand`. Evidence:
  ```
  $ sed -i 's/other than \\`-s\\`, \\`-t\\`, \\`-d\\`, or \\`-e\\`/other than \\`-s\\`, \\`-t\\`, or \\`-d\\`/' src/instructions/index.ts
  $ pnpm exec vitest run --project unit src/instructions
        Tests  2 passed (2)
  $ sed -i 's/, and any option before the subcommand, \\`--set\\` and \\`--profiles\\` included\./, \\`--set\\` and \\`--profiles\\`./' src/instructions/index.ts
  $ pnpm exec vitest run --project unit src/instructions
        Tests  2 passed (2)
  ```
  (tree restored with `git checkout .` afterwards)

- [note] The adb refusal line is incomplete: on the gateway path the Android driver also refuses a bare `simlock adb shell` (no command, no terminal), and the instructions never mention it, while the test title `name every refused passthrough verb the drivers refuse` claims full coverage its body cannot prove for that refusal (testing rule 1). Evidence: `src/drivers/android/index.ts:602-606`, `src/instructions/index.ts:53`, `src/instructions/index.test.ts:53`.

- [note] The adb refusal line overstates the option refusal: `simlock adb --version` and `simlock adb --help` on their own pass through, so "any option before the subcommand other than `-s`, `-t`, `-d`, or `-e`" is refused is not what the driver does (architecture rule 13). Evidence: `src/drivers/android/index.ts:285`, `src/drivers/android/index.ts:327-329`, `src/instructions/index.ts:53`.

- [note] `src/instructions/index.ts` is a second home, outside the driver modules, for simctl/adb knowledge: what `SIMLOCK_IOS_DEVICE_SET` and `ANDROID_ADB_SERVER_PORT` mean, the refused verb lists, snapshot and udid concepts (architecture rule 2, which says the lease `environment` keys are opaque outside the drivers), and the CLI comment that says this knowledge "still live[s] entirely in the driver" is no longer accurate (architecture rule 13). Evidence: `src/instructions/index.ts:48-53`, `src/cli/index.ts:597-599`.

- [note] The full e2e lane run failed three pre-existing tests on teardown (`withDaemon teardown found stray daemon process(es) that outlived daemon stop`) in `doctor-drift`, `error-exit-codes`, and `mcp-session` (the force-release test, not the new one); all three passed on an immediate re-run of those files, and none exercises a path this diff touches, but the failures were not reproduced on `main` (testing rule 5). Evidence:
  ```
  $ pnpm run test:e2e
   Test Files  3 failed | 16 passed | 4 skipped (23)
        Tests  3 failed | 61 passed | 1 expected fail | 9 skipped (74)
  $ pnpm exec vitest run --project e2e --tags-filter='!slow' e2e/doctor-drift.test.ts e2e/error-exit-codes.test.ts e2e/mcp-session.test.ts
   Test Files  3 passed (3)
        Tests  16 passed (16)
  ```

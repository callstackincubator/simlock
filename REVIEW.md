- [blocking] The positional-argument rejection in `runInstructions` is reached by no test: with it deleted the unit suite and the e2e lane stay green (the lane's two failures are unrelated, see the output), although `docs/CLI.md` promises "Any other flag or argument is a usage error (exit 2)" (testing rule 3; architecture rule 13). Evidence: `src/cli/index.ts:890`, `docs/CLI.md:864`, and
  ```
  $ # deleted lines 890-891 of src/cli/index.ts (the `values.positionals.length > 0` throw)
  $ pnpm exec vitest run --project unit
   Test Files  99 passed (99)
        Tests  1860 passed | 2 skipped (1862)
  $ pnpm run test:e2e
   Test Files  2 failed | 17 passed | 4 skipped (23)
        Tests  2 failed | 62 passed | 1 expected fail | 9 skipped (74)
  # neither failure exercises `instructions`: a withDaemon teardown stray-daemon check in
  # e2e/error-exit-codes.test.ts, which fails the same way on the unmodified tree, and the
  # MCP lease-across-restart test, which passed on re-run with this mutation still applied
  ```

- [blocking] The unit test titled "name every refused passthrough verb the drivers refuse" proves only the verbs the drivers keep in exported constants; `runtime delete` is refused by a literal, the caller-supplied `--set`/`--profiles` refusal by an unexported set, so removing `runtime delete` from the instructions leaves the test green (testing rules 1 and 4). Evidence: `src/instructions/index.test.ts:21-37`, `src/drivers/ios/index.ts:1278-1280`, `src/drivers/ios/index.ts:94`, and
  ```
  $ # removed ", `runtime delete`" from src/instructions/index.ts:52
  $ pnpm exec vitest run --project unit src/instructions src/cli src/mcp
   Test Files  8 passed (8)
        Tests  196 passed (196)
  $ pnpm exec vitest run --project unit
   Test Files  99 passed (99)
        Tests  1860 passed | 2 skipped (1862)
  ```

- [note] The `--help`/`-h` branch of `runInstructions` and the new `instructions [--json]` line in `USAGE` are reached by no test: deleting the `help` option and its branch keeps every test green (testing rule 3). Evidence: `src/cli/index.ts:883-889`, `src/cli/index.ts:59`, and
  ```
  $ # removed the `help` option and the `if (values.help)` branch from runInstructions
  $ pnpm exec vitest run --project unit src/cli && pnpm run build && pnpm exec vitest run --project e2e e2e/agent-instructions.test.ts
   Tests  122 passed (122)
   Tests  3 passed (3)      # (with the daemon-touching mutation below applied at the same time, only the first test failed, on its socket assertion)
  ```

- [note] The explicit `resources: {}` server capability is redundant: the SDK's `registerResource` registers `resources: { listChanged: true }` itself, and with the declaration removed the MCP e2e test still lists and reads the resource (testing rule 3). Evidence: `src/mcp/server.ts:100`, `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:339-343`, and
  ```
  $ # changed `{ capabilities: { logging: {}, resources: {} } }` to `{ capabilities: { logging: {} } }`
  $ pnpm run build && pnpm exec vitest run --project e2e e2e/mcp-session.test.ts e2e/agent-instructions.test.ts
   Test Files  2 passed (2)
        Tests  7 passed (7)
  ```

- [note] The instructions tell an agent that on exit 13 "The error message names that lease", but when the conflict is a queued request rather than a granted lease the message names only the requester, so an agent that parses it for a lease id finds none (architecture rule 13: a claim in a doc is part of the change). Evidence: `src/instructions/index.ts:41`, `src/core/wait-queue.ts:69-71`.

- [note] The instructions say `simlock simctl` refuses "a `--set` or `--profiles` of your own", but the driver refuses every argument ahead of the subcommand that starts with `-`, named or not, so an agent following the text will have any other leading flag refused too (architecture rule 13). Evidence: `src/instructions/index.ts:52`, `src/drivers/ios/index.ts:1310-1330`.

- [note] The "Exit codes to handle" section omits exit 12 (`NO_DRIVER`, `RUNTIME_MISSING`, `UNKNOWN_MODEL`, `UNKNOWN_WORKER`), the one code where retrying cannot help and where the `--allow-download` decision the text forbids arises; an agent told to "branch on code" has no branch for it. Evidence: `src/instructions/index.ts:37-44`, `src/contract/errors.ts:229-231`.

- [note] `src/instructions/index.ts` is a module outside the drivers that names Android and iOS concepts the drivers are meant to encapsulate: that `ANDROID_ADB_SERVER_PORT` is a port, that `SIMLOCK_IOS_DEVICE_SET` is the `--set` path, adb's serial flag `-s`, `emu avd snapshot delete`, and both drivers' refusal lists restated as prose (architecture rule 2: "nothing outside `drivers/android` may reference AVDs, snapshots, adb serials, or ports"; the CLI text `docs/CLI.md` already does the same, so this may be accepted precedent, but the unit test only ties part of the restated list to the drivers, see the second finding). Evidence: `src/instructions/index.ts:49-53`, `docs/internal/agent-rules/architecture.md:11-19`.

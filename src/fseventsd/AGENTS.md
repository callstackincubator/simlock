# fseventsd

Does: tells an operator, in `simlock doctor` on a macOS worker, that the macOS service `fseventsd` uses over 2 GB of memory ([ADR 0088](../../docs/internal/adr/0088-a-macos-worker-checks-fseventsd-when-doctor-runs.md)).

## Rules

- It only warns. Restarting `fseventsd` needs root, so the fix is the worker troubleshooting page's launchd job, never code here.
- The memory is read when `findings()` runs, never on a timer: `pgrep -x fseventsd`, then `top -l 1 -pid <pid> -stats mem`, both through `ctx.processRunner`, each bounded by `READ_TIMEOUT_MS`.
- A reading that fails (no figure, a bad exit, a timeout) adds no finding and logs one warning per run.
- Off macOS the module is `unavailable` with a finding, and runs no command.

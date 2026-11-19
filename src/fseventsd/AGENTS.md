# fseventsd

Does: tells an operator, in `simlock doctor` on a macOS worker, that the macOS service `fseventsd` has grown past its memory limit ([ADR 0088](../../docs/internal/adr/0088-a-macos-worker-checks-fseventsd-when-doctor-runs.md)).

## Rules

- It only warns. Restarting `fseventsd` needs root, so the fix is the worker troubleshooting page's launchd job, never code here.

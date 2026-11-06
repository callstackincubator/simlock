# Updater

Does: the process a daemon starts to install a Simlock version with npm and restart the role's daemon; it rolls back a version that does not start.

## Rules

- `main.ts` imports everything statically: the install replaces the files on disk, so the whole updater must be loaded before it starts. A lazy `import()` on the updater's path would load a replaced file.
- A failed install leaves the daemon untouched: nothing is stopped before the install succeeds.
- "Stopped" is a refused connection, and for the old daemon an exited pid, never a failed handshake: a daemon that accepted `daemon.stop` still holds the socket and the databases while it settles. A socket file with nothing behind it is stopped too.
- `socketHeld` is the one check that a socket still has a daemon behind it. The daemon uses it too, for its shared-install check.
- The databases are copied only after the stop, into an `update-backup` emptied first (a failed rollback leaves the folder behind), and restored only when nothing holds the socket. Under a service manager the service may have restarted a daemon by then: it gets `daemon.stop` first. One that never stops leaves the copy in `update-backup`, and the rollback fails.
- The probe's `state` is `daemon.update` with `query`, a call every protocol version accepts.
- Every probe call and the `daemon start` run are bounded (`CALL_LIMIT_MS`, `START_LIMIT_MS` in `index.ts`). A call past its limit counts as no answer, but a `listening` call past it counts as still listening. A `daemon start` past its limit is a failed start.
- The daemon reads the updater's stdout, one JSON line per stage or failure, and `update-result.json` (`src/daemon/update-coordinator.ts`). Change both ends together.
- A rollback still exits 1. A failed rollback goes to stderr, which is `daemon.log`.

## Known gaps

- **A new daemon that ignores `daemon.stop` is not killed.** Its pid is not known to the probe, so only the old daemon's `--pid` gets SIGKILL at the stop limit.

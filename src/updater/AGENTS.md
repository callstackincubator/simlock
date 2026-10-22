# Updater

Does: the process a daemon starts to install a Simlock version with npm and restart the role's daemon; it rolls back a version that does not start.
Entry: `index.ts` → `runUpdater(options)` (returns the exit code), `checkInstall`, `parseUpdaterArgs`, `DaemonProbe`, `createDaemonProbe` (`probe.ts`, the admin-client probe `main.ts` uses). `main.ts` is the process entry: `node <package root>/dist/updater/main.js --from <v> --to <v> --pid <daemon pid> [--gateway]`, env `SIMLOCK_HOME`.
Uses: ports, admin (in `probe.ts` only). Never imports: daemon, cli, core.
Started by: a daemon through `UpdaterLauncher` (no caller yet).

## Steps

1. `npm i -g simlock@<to>` through `NpmCli` (10 min). A failure prints `{"failed":{"stage":"installing","message":…}}` and exits 1; the daemon is untouched.
2. `daemon.stop`, then wait until nothing holds the socket and `--pid` has exited (10 min, then SIGKILL `--pid`). Holding the socket means a connection to it succeeds, even if the daemon then closes it (a daemon that accepted `daemon.stop` is still settling); a refused connection or a socket file with nothing behind it is stopped (`probe.ts` `listening`).
3. Copy `state.db`, `history.db` and their `-wal`/`-shm` to the `update-backup` folder of the data directory.
4. `node <root>/dist/cli/main.js daemon start [--gateway]`, then poll the probe until `running` at version `to` (2 min).
5. Not started: stop a daemon that still answers the handshake (10 min), write `update-result.json` (0600, `{ from, to, stage: "restarting", message, at, rolledBack }`), reinstall `from`, then restore the database copy and start it. The restore waits until nothing holds the socket: a daemon that does then (the service restarted it) gets `daemon.stop` first (10 min); one that never stops leaves the copy in `update-backup` and the rollback fails. The updater still exits 1; a failed rollback goes to stderr (`daemon.log`).
6. A good start deletes the `update-backup` folder.

Each probe call has a 30 s limit and `daemon start` a 2 min one (`index.ts` `CALL_LIMIT_MS`, `START_LIMIT_MS`); a call past its limit counts as no answer (a `listening` call: still listening), and a `daemon start` past it as a failed start.

Progress is one JSON line per stage on stdout: `{"stage":"installing"}`, `{"stage":"restarting"}`.

- `main.ts` imports everything statically: the install replaces the files on disk, so the whole updater must be loaded before it starts.
- `checkInstall` compares the real path of the running package root with `<npm root -g>/simlock`; anything else is `{ ok: false, foundPath }`.
- The new daemon is not killed when it ignores `daemon.stop` for 10 minutes: its pid is not known to the probe.

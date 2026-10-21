# 0041. The daemon can run under the user's service manager

- **Status:** Proposed
- **Date:** 2026-10-21
- **Issue:** [#818](https://github.com/callstackincubator/simlock/issues/818)
- **Supersedes:** nothing. Builds on [ADR
  0034](0034-one-worker-per-user-and-the-folder-says-what-a-daemon-is.md):
  one service per role, because one worker runs per user and the folder
  says what a daemon is.

## Context

A daemon starts only when a command needs it: the CLI or the MCP server
spawns `dist/daemon/main.js` detached, with the Node binary that ran the
command, and points its stdout and stderr at `daemon.log`. Nothing starts
it at login, and nothing brings it back after a crash. A worker Mac that
reboots does not rejoin its fleet until someone types a `simlock`
command on it, and a gateway stays down until someone starts it.

Both service managers an operator would use stop a service with SIGTERM
(launchd at logout and on `bootout`, systemd on `systemctl stop`). The
daemon has no SIGTERM handler today, so it dies without its clean stop:
work in flight is cut, `daemon.stopping` is never sent and `admin.token`
stays behind.

```mermaid
flowchart LR
  subgraph Today
    L1[login] --> N1[nothing runs]
    C1[a simlock command] --> S1[CLI spawns daemon, detached]
    X1[daemon crashes] --> N1
  end
  subgraph After
    L2[login] --> M[launchd / systemd starts the daemon]
    X2[daemon exits non-zero] --> M
    C2[a simlock command] --> Q{service installed?}
    Q -- yes --> M
    Q -- no --> S2[CLI spawns daemon, detached]
  end
```

## Decision

1. **`simlock daemon install` and `simlock daemon uninstall`** install
   and remove a per-user service for one role. The global `--gateway` and
   `--local` flags pick the role, as for every other `daemon` command. On
   macOS it is a launchd LaunchAgent in `~/Library/LaunchAgents`, loaded
   into the `gui/<uid>` domain. On Linux it is a systemd user unit in
   `$XDG_CONFIG_HOME/systemd/user` (or `~/.config/systemd/user`). On any
   other platform both commands are a usage error (exit 2). They run in
   the CLI, beside the auto-start launcher and `config set`: they set up
   the machine and hold no daemon state.
2. **One service name per role and home.** `com.callstack.simlock.worker`
   and `com.callstack.simlock.gateway` for the default home `~/.simlock`.
   For any other `SIMLOCK_HOME`, the name gains `.` and the first six hex
   digits of the SHA-256 of the resolved absolute home path, so a test or
   a second home never touches the operator's real service. On Linux the
   unit file is `<name>.service`.
3. **The service runs the daemon in the foreground**, with the command
   auto-start uses: the absolute Node path and the absolute
   `dist/daemon/main.js` path of the CLI that ran install, plus
   `--gateway` for a gateway. Install saves `SIMLOCK_HOME`, `PATH`,
   `ANDROID_HOME` and `ANDROID_SDK_ROOT` (each only when set) in the
   service file, and nothing else from the shell. stdout and stderr are
   appended to the role's `daemon.log`, as with auto-start. The daemon
   keeps writing its own log there.
4. **Restart after a failure only.** launchd: `KeepAlive` with
   `SuccessfulExit` false, and its default 10 s throttle. systemd:
   `Restart=on-failure`, `RestartSec=10`, `StartLimitIntervalSec=0`. A
   clean stop (`daemon stop`, SIGTERM) exits 0 and stays stopped until
   the next login or start. Every stop the daemon makes for a failure
   (`convergence-failed`, `http-start-failed`, `history-refused`, a start
   that throws) exits 1, as it does today.
5. **SIGTERM is a clean stop.** The daemon entry handles SIGTERM with the
   same stop as `daemon.stop`, reason `signal`, then exits 0. A second
   SIGTERM during the stop changes nothing.
6. **A start goes through the service when one is installed.** When the
   role's service file exists, `daemon start` and every auto-start (CLI
   and MCP) ask the service manager to start it (`launchctl kickstart`,
   `systemctl --user start`) instead of spawning a child. The startup
   deadline and the probe stay as they are. So a daemon on a machine with
   a service is always supervised.
7. **Install is repeatable and takes over a running daemon.** Install
   writes the service file, replacing any earlier one, stops the role's
   daemon if one is running (a clean stop; leases persist), and loads and
   starts the service. Uninstall stops the service's daemon, unloads the
   service and deletes the file. Both say on stdout what they stopped.
8. **Start at login, not at boot.** Install changes no system setting. It
   prints one line on how to start after a reboot: automatic login on
   macOS, `loginctl enable-linger` on Linux.
9. **The state is reported, not assumed.** `simlock daemon status` prints
   a `Service:` line for both roles: not installed, installed, or
   installed with a saved path that no longer exists. A worker's
   `simlock doctor` adds a `service-broken` finding when the service file
   names a Node or `main.js` path that is gone. Both read the state
   through one port, so the rule lives in one place.

```mermaid
sequenceDiagram
  participant U as operator
  participant C as simlock CLI
  participant M as launchd / systemd
  participant D as daemon
  U->>C: simlock daemon install
  C->>D: daemon.stop (when running)
  D-->>C: stopping, exits 0
  C->>M: write service file, load, start
  M->>D: node main.js [--gateway]
  C-->>U: Service installed + reboot hint
  D--xM: crash (exit 1 or signal)
  M->>D: start again after 10 s
  U->>C: simlock daemon stop
  C->>D: daemon.stop
  D-->>M: exit 0, stays stopped
  U->>C: simlock status
  C->>M: start the service
  M->>D: node main.js
```

## Consequences

- A worker rejoins its fleet and a gateway comes back at login, and both
  come back after a crash, without anyone typing a command.
- The service file freezes the Node and simlock paths of install time. A
  Node upgrade under nvm breaks it; `daemon status` and `doctor` say so,
  and running install again fixes it.
- A permanent start failure retries every 10 s forever and logs each try
  to `daemon.log`.
- `daemon.log` rotation renames the file under the service manager's open
  descriptor, so crash output after a rotation lands in `daemon.log.1`.
  Auto-start has the same limit today; `daemon logs` reads both files.
- Adding the `service-broken` doctor finding is a contract shape change:
  the protocol version goes up by one.

## Alternatives considered

- **Keep the daemon alive on any exit.** `daemon stop` would then have to
  go through `launchctl` or `systemctl`, or the daemon comes right back.
  Rejected: more code in stop, for no gain over restarting after a
  failure only.
- **A system LaunchDaemon or system unit started at boot.** Simulators
  belong to the user's login session, and a system service runs as root.
  Rejected.
- **Spawn as today even when a service is installed.** A daemon started by
  a command after `daemon stop` would run unsupervised until the next
  login, with no visible sign. Rejected.
- **Copy the whole shell environment into the service file.** Secrets and
  tokens from the shell would end up in a plist. Rejected for the four
  named variables.
- **Install enables linger on Linux.** It may prompt for a password
  through polkit and changes a system setting. Rejected for a hint.

# CLI

Does: the `simlock` command surface over `simlock/admin` — parse, render, hold a lease while alive.
Entry: `main.ts` (the `simlock` bin) → `index.ts` `runCli(argv)`.
Uses: admin, client (types), agent-identity, lease-policy, bus (event file reader), core
(`loadConfig` only), contract, ports; mcp, loaded on demand. Never imports: daemon, drivers,
gateway, http.
Surface: [CLI.md](../../docs/CLI.md) — every command, flag and exit code.

## Files

| File             | Role                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `index.ts`       | `runCli`, every command, `buildCliEnvironment`, rendering               |
| `main.ts`        | The bin; sets `process.exitCode`                                        |
| `passthrough.ts` | `spawnPassthrough`: runs a resolved simctl/adb command, stdio inherited |
| `follow-log.ts`  | `followLog`: `daemon logs --follow` across rotations                    |

## How it works

1. **Route** — `runCli` takes out a global `--token`, then switches on the first word.
   Any error is one JSON line on stderr, `{ error: { code, message } }`. Exit code:
   `ERROR_TABLE` `cliExitCode`, 2 for a usage error, else 1.
2. **Connect** (`connectDaemonClient`) — always `connectSimlockAdmin`; principal =
   `resolveRequesterId(env, <pid>)`. Credential, first found: `--token` →
   `SIMLOCK_ADMIN_TOKEN` → `admin.token` in the data directory (3 reads, 50 ms apart).
   None, or a rejected one → an `agent` session and one stderr `notice` line.
3. **Auto-launch** (`AutoLaunchIpcConnector`) — when nothing listens: load the config
   first (a bad one fails on this stderr), launch the daemon detached, retry every 50 ms
   for 5 s.
4. **`simlock lease`** — `requestLease`; progress pushes as JSON lines on stderr; one result
   line on stdout, with the session's `role` (`--export-env`: shell lines). `--agent-id`
   sets the requester. Then, unless `--detach`:
   - renew on `startLeaseRenewal` (a third of the TTL);
   - wait for `SIGINT`/`SIGTERM`, or the exit of `--bind-pid` or the parent (`ParentWatch`);
   - stop renewing, release within `RELEASE_TIMEOUT_MS` (5 s), close.
     Lease lost → exit 14. Connection lost → `DAEMON_CONNECTION_LOST`; the lease runs to its deadline.
5. **`simlock simctl` / `adb`** — reads `status.get` `daemon.mode`:
   - worker: `driver.passthrough` returns a scoped command; `spawnPassthrough` runs it here.
   - gateway: `device.exec` on `--lease`, or the requester's only lease. A piped stdin is
     read to EOF first; output chunks go to stdout and stderr.
     `PASSTHROUGH_REFUSED` and `UNKNOWN_PASSTHROUGH_TOOL` become usage errors (exit 2).
6. **`simlock events --follow`** — subscribe, then replay, then print buffered pushes not
   already replayed (by `eventKey`). `--since` without `--follow` never launches a daemon;
   with none running it reads `events.jsonl` itself.
7. **`simlock daemon logs --follow`** — `followLog` polls every 250 ms from a byte offset.
   A new identity on `daemon.log.1` is a rotation: print its rest, restart at offset 0.
8. **`simlock config set`** — validates the merged file with `loadConfig`, writes
   `config.json` atomically, mode `0600`.
9. **`simlock mcp`** — imports `src/mcp/main.ts` and runs it.

## Rules

- No decision logic and no state beyond the lease it holds (architecture rule 8).
- The connection holds nothing: a lease ends by release or TTL.
- Renewal stops before the release; no timer outlives a command.
- `CliEnvironment` carries every port and process handle; tests build it with fakes.
- Nothing printed names a file path in this repo (documentation rules).

## Known gaps

- **`simlock simctl` / `adb` can hang on a piped stdin.** Through a gateway,
  `readPipedStdin` reads stdin to EOF before sending, with no bound. A pipe nobody closes
  blocks before the command goes out. Redirect stdin from `/dev/null`.

# CLI

Does: the `simlock` command surface over `simlock/admin` — parse, render, hold a lease while alive.
Entry: `main.ts` (the `simlock` bin) → `index.ts` `runCli(argv)`.
Uses: admin, bus (event key, type), client (types), agent-identity, lease-policy, history (reader), core
(`loadConfig` only), contract, ports, module-registry (`optionalModules` only); instructions
(`commands/instructions.ts` only); mcp, loaded on demand. Never imports: daemon, drivers, gateway, http.

Everything except `agent-identity` (the requester-id resolver, the one cheap component) is
loaded **on demand**: the CLI's own shared files (`main.ts`, `index.ts`, `tree.ts`,
`errors.ts`, `usage-error.ts`, `types.ts`, `environment.ts`, `stdio.ts`, `log-file.ts`,
`args.ts`, `connect.ts`) import no component for a value and `environment.ts` none but
`agent-identity`, so the router answers `--help` or a usage error without loading `core`,
`contract`, `admin`, `ports` or any command module. The dependency rule
`cli-router-imports-no-component-values` rejects a value import of any other component into
those files; `lazy-loading.test.ts` measures what a command loads when it runs.
Surface: [cli.mdx](../../website/src/content/docs/docs/reference/cli.mdx) — every command and flag; [errors.mdx](../../website/src/content/docs/docs/reference/errors.mdx) — exit codes.

## Files

| File             | Role                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `index.ts`       | `runCli`: the global `--token`, `--gateway` and `--local`, the command lookup, the error boundary |
| `tree.ts`        | The command tree — each node names the module that implements it                                  |
| `environment.ts` | `buildCliEnvironment`: the ports a command may reach, from the ports it is handed                 |
| `types.ts`       | `CliEnvironment` and its ports — types only, so routing loads no code                             |
| `errors.ts`      | The error → code/exit mapping                                                                     |
| `usage-error.ts` | `UsageError` and `withHelpHint`, the help pointer's one wording                                   |
| `connect.ts`     | `connectDaemonClient`: credential order, the admin session, the notice                            |
| `args.ts`        | `commandArgs` / `requiredPositional` / `subcommandOrUsage` / `writeResult`                        |
| `commands/*.ts`  | One module per command, `run(argv, context)`; loaded by the tree on a hit                         |
| `format.ts`      | The human renderers for `status`, `worker list`, `daemon start`, etc.                             |
| `duration.ts`    | `parseDuration` for `--ttl`-style flags                                                           |
| `termination.ts` | The signals and parent-exit wait a held lease blocks on                                           |
| `log-file.ts`    | `readLogFile`: `daemon.log` plus a rotated generation                                             |
| `stdio.ts`       | `readPipedStdin`: a piped stdin for `simctl`/`adb`, read to EOF                                   |
| `passthrough.ts` | `spawnPassthrough`: runs a resolved simctl/adb command, stdio inherited                           |
| `follow-log.ts`  | `followLog`: `daemon logs --follow` across rotations                                              |
| `main.ts`        | The bin; sets `process.exitCode`                                                                  |

`format.ts`, `duration.ts` and `termination.ts` are reached only from a command module, and
`follow-log.ts` and `passthrough.ts` only from a dynamic import inside `environment.ts`.

## How it works

1. **Route** — `runCli` takes out the global `--token`, `--gateway` and `--local` (bare, anywhere; `--gateway=<x>` and `--local=<x>` are usage errors, and both flags together are one), then walks `COMMANDS` to the deepest
   node the words name and loads that one module (a parent and its children can share it).
   Nothing runs without a node: an unmatched word is
   a usage error before any command module is read. `--help`/`-h` as the first word, or no
   words, prints the root usage without building an environment at all. Any error is one JSON
   line on stderr, `{ error: { code, message } }`. Exit code: `ERROR_TABLE` `cliExitCode`,
   2 for a usage error, else 1. The flag goes to `resolveDaemonHome`, which picks the folder:
   `--gateway` `<root>/gateway`, `--local` the worker, and with no flag the gateway only when
   one is present and `<root>/instance.json` does not exist. The launcher gets `--gateway`
   whenever the chosen role is the gateway (`SIMLOCK_HOME` still the root). When a worker
   answers `UNSUPPORTED_IN_WORKER_MODE`, no `--gateway` was given and a gateway is present,
   the printed message gets the `--gateway` hint appended. With `--gateway` and no gateway
   present every command but `daemon start`, `daemon install`, `daemon uninstall`, `config set`, `mcp` and `instructions` (and any `--help`, except after `adb`/`simctl`)
   stops with `GATEWAY_NOT_PRESENT`, exit 2, before it connects.
2. **Connect** (`connectDaemonClient`) — always `connectSimlockAdmin`; principal =
   `resolveRequesterId(env, <pid>)`. Credential, first found: `--token` →
   `SIMLOCK_ADMIN_TOKEN` → `admin.token` in the data directory (3 reads, 50 ms apart).
   None, or a rejected one → an `agent` session and one stderr `notice` line.
3. **Auto-launch** (`AutoLaunchAdminConnector`) — when nothing listens: load the config
   first (a bad one fails on this stderr), launch the daemon (`launcherFor`: through the
   service when it is loaded and whole, else spawned detached with a stderr notice; `daemon install` and
   `daemon uninstall` write the service through the `ServiceManager` port; `daemon status` only reads its state and prints a `Service:` line, with no line on a refused handshake or an unsupported platform), retry every 50 ms
   for `DAEMON_STARTUP_TIMEOUT_MS`; a launched daemon that exits fails the command at once
   with `startErrorFrom`'s text, unless another daemon answers a last connect; a start through the service never reports an exit, so a daemon it refuses fails at the deadline with the `daemon.log` lines since the start. After a launch, `status.get` probes the connection
   before handing it to a command, within that same deadline. A connection loss during the handshake or this
   probe becomes `DAEMON_STARTUP_FAILED`; a silent probe times out with that code and starts closing
   its client without waiting for the daemon to end its side. An answered probe ends the window, including a `starting` status: subsequent
   command failures retain their original codes even while a lease queues or boots.
   The connector retains the launch deadline across a rejected credential and agent fallback.
   A pre-existing daemon is never probed or reclassified; other daemon errors keep their codes.
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
   with none running it reads `history.db` itself (read-only; no file is empty, an unreadable
   one is an error, exit 1). `simlock status` adds a `History:` line for a history that is not
   written, one for a set-aside file, one after a rebuild of the usage figures and one after a failed rebuild. `simlock config set` drops `eventLog.rotateBytes` and says so on stderr.
   6a. **`simlock stats`** — `usageWindow` (contract) turns `--since`, `--from`, `--to` into a window; each refusal is a usage error (exit 2) worded here. Asks `usage.get` and prints `formatUsage` (`stats.ts`) or the answer as `--json`; computes no figure. `--csv` asks with `includeLedger` and writes `ledgerCsv` (`csv.ts`, RFC 4180, CRLF, a leading `'` before `=`, `+`, `-`, `@`); `--csv` with `--json` is a usage error; a `ledgerTruncated` answer adds a stderr notice.
7. **`simlock daemon logs --follow`** — `followLog` polls every 250 ms from a byte offset.
   A new identity on `daemon.log.1` is a rotation: print its rest, restart at offset 0.
8. **`simlock config set`** — validates the merged file with `loadConfig`, writes
   `config.json` atomically, mode `0600`.
9. **`simlock mcp`** — imports `src/mcp/main.ts` and runs it, passing the global flag as `{ daemonFlag }`.
10. **`simlock instructions [--json]`** — prints the static rules text from `src/instructions`, or
    one JSON object `{ instructions }`; never connects to a daemon.

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

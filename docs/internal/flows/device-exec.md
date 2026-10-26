# device.exec

Modules: [daemon](../../../src/daemon/AGENTS.md), [gateway](../../../src/gateway/AGENTS.md).
Contract: `src/contract/operations.ts` `deviceExec` — role `agent`, effect `write`.
Input (strict): `{ leaseId, tool, args, stdin?, requesterId? }`. Output: `{ exitCode }`.
Runs the command on the machine that owns the device and streams its output back.

## Callers

- `simlock/client` `exec` over the socket. `simlock simctl|adb` uses it only when
  the daemon is a gateway, on `--lease <id>` or the caller's one lease. Against a
  worker the CLI asks `driver.passthrough` for the command and spawns it itself,
  with its own terminal.
- The MCP tool `run_on_device` ([mcp](../../../src/mcp/AGENTS.md)): the same `exec` on the
  session's held lease, which the caller never names.
- HTTP `POST /v1/leases/{id}/exec` → SSE: `output`, then `exit` or `error`.
  The requester is the token's; only an `operator` token may send `requesterId`.
  Every failure before the process exists is a plain JSON error with its status;
  after it, the stream is committed (`200`) and a timeout arrives as `error`.

## On a worker

1. Pipeline — `runDispatch` (`src/daemon/dispatch.ts`): parse → role → `authorize`
   → park on readiness → handler.
2. Authorize — once, at the start:
   - `agent` session: `requesterId` present → `FORBIDDEN`; principal must equal
     the lease's `ownerId`.
   - `admin` session: no bypass. `requesterId ?? principal` must equal the
     lease's `requesterId`.
   - An unknown lease passes; the handler answers `UNKNOWN_LEASE`.
3. Lease and device from the `Registry` snapshot (`Dispatcher` `device.exec`).
4. Resolve — `DriverCatalog.passthrough(tool, device, args, { hasTerminal: false, platform })`.
   The first driver whose `passthroughTools` lists the tool answers; none →
   `UNKNOWN_PASSTHROUGH_TOOL`. A refusal → `PASSTHROUGH_REFUSED`.
   The driver fills the lease's device into the command, and refuses one that names
   another device (ADR 0047), see "Resolution per platform".
5. Env — `execBaseEnvironment(process.env)` (`src/daemon/exec-env.ts`, the allowlisted
   keys, read once at start) + the command's `env`, minus its `unsetEnv`.
6. Spawn — `ProcessRunner.spawnStreaming`, pipes only. `stdin` is written once,
   then closed.
7. `started` push the moment the process exists, then one `output` push per chunk
   (`{ requestId, stream, chunk }`). The push write is awaited before the child is
   read again: a slow reader slows the command. Nothing is buffered; no size cap.
8. Wait, raced against `exec.timeoutMs` (10 min). Exit first → `{ exitCode }`.
   Timeout first → SIGTERM, SIGKILL after 10 s, answer `EXEC_TIMEOUT`.

### Resolution per platform

| Tool | Device | Command | Refused |
|---|---|---|---|
| `simctl` | iOS simulator | `xcrun simctl --set <device root> <args>` (no `--set` under `drivers.ios.deviceSet: default`); the lease's UDID goes first among the operands of a device verb (`src/drivers/ios/simctl-device.ts`) | another UDID or `booted` on a device verb, `simctl` on a non-iOS lease, `create`, `erase`, `delete`, `shutdown all`, `runtime delete`, any flag before the subcommand, a physical device |
| `devicectl` | iOS physical | `xcrun devicectl <cmd> --device <udid> <rest>`; `--device` added unless the args name one; a `--device` / `-d` that is not the lease's UDID is refused | a command not on the allowed list (`src/drivers/ios/devicectl-exec.ts`), an option off it, host-path options (`--json-output`, `--log-output`, `--destination`, `--file`, `--filter`), a simulator |
| `adb` | Android emulator | `adb -P <simlock port> -s <serial> <args>`, `ANDROID_ADB_SERVER_PORT` set; no `-s` for a no-device subcommand (`devices`, `version`, `forward --list`, …) or an empty address | `-s` other than the lease's serial, `-t` whatever it names, `-e`, `-d`, `adb` on a non-Android lease, bare `adb shell`, `kill-server`, `emu kill`, `emu avd stop`, `emu avd snapshot delete`, globals other than `-s`/`-t`/`-d`/`-e` |
| `adb` | Android physical | `adb -P <default port> -s <serial> <args>`; strips `ANDROID_ADB_SERVER_ADDRESS`, `ADB_SERVER_SOCKET`, `ANDROID_SERIAL` | bare `adb shell`, any leading flag, server and transport verbs (`kill-server`, `connect`, `tcpip`, `usb`, …), `reboot bootloader`/`sideload`, a closed default-server gate |

A bare `adb shell` is refused only here (`hasTerminal: false`); the local
`simlock adb shell` stays interactive. For `simctl` and `adb` the daemon parses
no argument beyond these lists; the driver (not the daemon) fills in and checks the device.

## Through a gateway

1. Pipeline — `GatewayDispatcher` runs the same `runDispatch`; `authorize`
   reads `FleetLeaseIndex` instead of a registry. Nothing parks.
2. `FleetLeaseCoordinator.exec`: unknown gateway lease → `UNKNOWN_LEASE`;
   worker not connected → `WORKER_UNREACHABLE`.
3. Forward over the uplink with the worker's lease id and
   `requesterId: gw:<gateway instance id>:<lease's requester>`. The worker checks it
   again as an `admin` session (worker step 2). Two hops, two checks.
4. Relay the worker's `started` and `output` pushes unchanged. The gateway parses
   nothing about the command.
5. Backstop: `gateway.execTimeoutMs` (11 min) → `EXEC_TIMEOUT` naming the worker.
   It fires only when the worker never answers; the worker's own 10 min fires
   first. After it, late chunks are dropped; the worker's command is not cancelled.

## Detach

A closed connection only stops the pushes (`DaemonServer`). The command runs on
to its exit or its timeout; the exit code is lost with the connection. A
gateway that gives up the same way leaves the worker's command running.

## Known gaps

- **Authorized once, at the start.** A command still running when its lease ends
  keeps running, maybe against a device reclaimed and granted again. Bounded by
  `exec.timeoutMs` and by `reclaiming` coming first; refused verbs stay refused.
- **An `agent` token on a worker is a host-level credential.** Commands run as the
  daemon's uid (`simctl spawn` runs any program on the host); `adb pull <device path>
  <host path>` writes any path the daemon can. Arguments are an accident boundary, not
  a security boundary. Only the env is trimmed to the allowlist.
- **No files.** Paths resolve on the worker: `simctl install /tmp/App.app` fails
  with the tool's own "no such file". Ship artifacts out of band; `device.upload`
  is an idea, not built.
- **No pseudo-terminal.** Line-oriented commands work; full-screen or prompting
  ones hang until `exec.timeoutMs`, then `EXEC_TIMEOUT`. Only bare `adb shell`
  is refused up front. Locally, `simlock adb shell` keeps its terminal.

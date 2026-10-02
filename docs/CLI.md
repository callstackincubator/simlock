# CLI reference

Part of the user manual: every command the simlock CLI is expected to
implement. Results are JSON on **stdout**; progress/diagnostics are JSON
lines on **stderr** — this is the default output, not an opt-in, because
agents are the primary audience. `status`, `catalog`, and
`daemon <start|stop|status|logs>` are the exception: they default to a
human-oriented view for interactive/operator use and accept `--json` to
switch to the structured form. Every other command's output is already
unconditionally JSON, so passing `--json` to it is a usage error (exit 2)
rather than a silent no-op. `simlock mcp` reserves stdout for MCP JSON-RPC
framing and accepts no flags at all.

On failure, every command writes one structured line to stderr:

```json
{"error":{"code":"NO_CAPACITY","message":"No device capacity is currently available"}}
```

`code` is the daemon's own error code where the failure came from the
daemon, or a stable CLI-level code otherwise: `USAGE` for bad flags/missing
arguments/unknown commands, `INTERNAL` for anything unexpected. An unknown
command or a missing required argument gets a `message` that ends with a
pointer to `simlock --help`, so a human hitting one from a terminal isn't
stranded with only a JSON blob — the full command banner itself is no
longer dumped to stderr on every failure, only on request via `--help`.

## Prerequisites

Simlock drives the platform tools already on the machine. It does not install
any of them; install them yourself before starting the daemon. A platform
whose prerequisites are missing is simply unavailable, and `simlock doctor`
names what is missing and how to install it.

iOS (macOS only):

- Xcode, installed and selected (`sudo xcode-select -s /Applications/Xcode.app`).
- The Xcode license accepted (`sudo xcodebuild -license accept`).
- Xcode's first-launch setup done (`sudo xcodebuild -runFirstLaunch`).

Android:

- An Android SDK, found at `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or
  `~/Library/Android/sdk`, in that order.
- The SDK's command-line tools (`sdkmanager` and `avdmanager`), from Android
  Studio or the [command-line tools download](https://developer.android.com/studio#command-line-tools-only).
- The `emulator` package (`sdkmanager --install emulator`).
- The `platform-tools` package (`sdkmanager --install platform-tools`).
- A JDK the SDK tools can run on, with `JAVA_HOME` set.

The daemon looks for a platform's tools once, when it starts. After installing
a missing prerequisite, restart the daemon (`simlock daemon stop`, then any
command starts it again) to bring the platform up.

## Global exit codes

| Exit | Error code | Meaning |
|---|---|---|
| 0 | — | success (for a `lease` that stayed alive: the lease ended normally) |
| 1 | `INTERNAL` | internal / unexpected error |
| 1 | `WORKER_UNREACHABLE` | the gateway cannot reach the worker this lease or request lives on (its uplink is down), or a worker named with `component install --worker` cannot be asked |
| 2 | `USAGE` | usage error (bad flags, missing required args, unknown command) |
| 2 | `BAD_FRAME` | malformed request frame sent to the daemon |
| 2 | `BAD_REQUEST` | request payload failed validation |
| 2 | `UNSUPPORTED_IN_GATEWAY_MODE` | this command acts on one machine (its devices, or its installed components) and the daemon answering is a gateway; run it on the worker, or for `component install` name the workers with `--worker` or `--all-workers` |
| 2 | `WORKER_CONNECTED` | `worker remove` on a worker whose uplink is still open; `drain` it and let it disconnect first |
| 2 | `UNKNOWN_REQUEST` | the daemon has no such operation — an operation this daemon's mode does not implement (`worker list` against a worker), or a client newer than the daemon |
| 2 | `PASSTHROUGH_REFUSED` | a `simctl`/`adb` verb simlock refuses, a caller-supplied `--set`/`-P`, or a bare `adb shell` where there is no terminal to give it |
| 2 | `UNKNOWN_PASSTHROUGH_TOOL` | a passthrough tool simlock does not wrap |
| 2 | `IDEMPOTENCY_CONFLICT` | a lease request reused an idempotency key its requester already sent for a different device; use a new key |
| 10 | `QUEUE_TIMEOUT` | timed out waiting for a device (`--timeout` elapsed) |
| 10 | `EXEC_TIMEOUT` | a `simctl`/`adb` command run through `device.exec` outlived `exec.timeoutMs` and was killed |
| 10 | `DOWNLOAD_TIMEOUT` | a runtime download, including the time spent waiting for another download on the same platform, outlived `downloads.timeoutMs` |
| 11 | `NO_CAPACITY` | capacity reached and `--no-wait` was set |
| 12 | `NO_DRIVER` | no driver registered for the requested platform |
| 12 | `RUNTIME_MISSING` | runtime not installed and no `--allow-download` |
| 12 | `UNKNOWN_MODEL` | unknown device model for the platform |
| 12 | `INSUFFICIENT_DISK_SPACE` | not enough free disk space to install a component |
| 12 | `LICENSE_NOT_ACCEPTED` | a required license (e.g. an Android SDK license) is not accepted |
| 12 | `UNKNOWN_WORKER` | `worker drain`/`undrain` or `component install --worker` naming a worker the gateway does not know |
| 12 | `DOWNLOADS_DISABLED` | `component install` on a machine whose `downloads.policy` is `"never"` |
| 13 | `REQUESTER_ALREADY_LEASED` | requester already holds a lease or has a pending request — one lease per agent in v1; release the named lease first |
| 14 | — | `lease` without `--detach` only: the daemon ended the lease without the holder asking (TTL expiry, operator `release`, or an unrecoverable device) |
| 15 | — | `component install --worker`/`--all-workers` on a gateway only: at least one worker did not end `installed` or `already-installed` (it refused, failed, was skipped, or its result is unknown) |

Every row but 14 and 15 matches the `cliExitCode` column of the contract's
error table (`src/contract/errors.ts`'s `ERROR_TABLE`) exactly — the CLI does
not maintain a second mapping. 14 and 15 are not daemon error codes but
outcomes of a command that succeeded: 14 of a `lease` that stays alive, so it
lives beside the table's other `lease` outcome, 0; 15 of an install on
several workers, whose per-worker report on stdout says which worker ended
how.
A daemon error code with no entry here (for example `UNKNOWN_LEASE`,
surfaced by `lease renew`) falls back to exit 1; the structured stderr line
still reports the specific code — a renew by a running `simlock lease` is the
exception, and exits `14`.

The five gateway-mode codes are placed on existing numbers rather than new
ones, and the numbers are fixed by the contract's error table in the PRs that
implement them:

- `WORKER_UNREACHABLE` is `kind: "transport"`, the fleet's version of
  `DAEMON_CONNECTION_LOST`: the thing you were talking to went away. Both
  exit `1`, and the stderr line's `code` is what distinguishes them.
- `WORKER_CONNECTED` and `UNSUPPORTED_IN_GATEWAY_MODE` are both "the request
  as sent is not one this daemon will take", which is what exit `2` already
  means for `USAGE` and `BAD_REQUEST`. Neither is retryable as written: the
  fix is a different command, or the same command against a different daemon.
  `UNSUPPORTED_IN_GATEWAY_MODE` in particular is permanent, not provisional:
  `nuke`, `cleanup`, `doctor`, `driver.passthrough` and `component list`
  stay per-worker operations rather than waiting on some later fleet-wide
  version. `component install` without a worker flag answers it too; with
  `--worker` or `--all-workers` it installs on the workers you name.
- `UNKNOWN_WORKER` takes `12`, the number the table already gives to "the
  thing you named cannot be resolved" (`UNKNOWN_MODEL`, `NO_DRIVER`), because
  that is what it is: a worker id the gateway has no record of.
- `PASSTHROUGH_REFUSED`, `UNKNOWN_PASSTHROUGH_TOOL`, and `UNKNOWN_REQUEST`
  are not new codes at all — they are already in the contract's table at exit
  `2`, and they are listed here because `device.exec` and the `worker.*`
  operations are new ways to reach them.
- `EXEC_TIMEOUT` joins `QUEUE_TIMEOUT` on `10`, the number that already means
  "a deadline elapsed". The two can never be confused, since only `lease`
  produces one and only `simctl`/`adb` produce the other. What *can* collide
  is a passthrough tool that itself exits `10` — `simlock simctl` and
  `simlock adb` exit with the tool's own status — so for those two commands
  branch on the stderr `{"error":{"code":...}}` line, which only simlock
  writes, rather than on the number alone.

---

## Agent identity

Leases are keyed by requester: at most one active lease per agent id,
enforced by the daemon. Each agent session needs a **stable** id for this to
constrain anything — a fresh id on every CLI invocation makes the constraint a
no-op, since every invocation looks like a different requester.

Resolution order, first match wins:

1. `--agent-id <id>` on `simlock lease`.
2. the `SIMLOCK_AGENT_ID` environment variable.
3. the session id of the agent tool Simlock runs under, as `<tool>:<session id>`:

   | Tool        | Variable                 | Id                 |
   | ----------- | ------------------------ | ------------------ |
   | Claude Code | `CLAUDE_CODE_SESSION_ID` | `claude-code:<id>` |
   | Codex       | `CODEX_SESSION_ID`       | `codex:<id>`       |

   The first variable in the table that is set and not empty wins.
4. a pid-derived value (not stable across invocations).

Under Claude Code or Codex nothing needs setting for the CLI: every `simlock`
command in one agent session, including its sub-agents and parallel commands,
is the same requester and shares that session's one lease. (`simlock mcp` gets
the session id under Claude Code only; see [`simlock mcp`](#simlock-mcp).)
Elsewhere, export
`SIMLOCK_AGENT_ID` once per agent session, with a distinct id per agent so
they don't collide. An explicit id always wins over the session id. The id
shows up as the requester in `simlock status` and `simlock list --leases`, so
an operator can tell which agent holds what.

## `simlock lease`

Acquire a device. Blocks while waiting for capacity, then while provisioning
and booting, then — unless `--detach` — keeps running, renewing the lease on
a timer and releasing it when it exits.

```
simlock lease --platform <ios|android> --device <model> [--os <version>]
              [--mode <slim|full>] [--agent-id <id>] [--timeout <duration>]
              [--no-wait] [--detach] [--ttl <duration>] [--allow-download]
              [--export-env] [--bind-pid <pid>]
```

There is only one kind of lease: every lease has a
TTL and lives until it expires, is renewed, or is released. `--detach`
changes what *this process* does after the grant, not what the daemon
granted.

- `--platform`, `--device` — required. `--os` defaults to the newest runtime
  already installed for that platform.
- `--agent-id` — this invocation's requester identity; see
  [Agent identity](#agent-identity). Defaults to `SIMLOCK_AGENT_ID`, then the
  agent tool's session id, then a pid-derived value.
- `--timeout` — max time to wait in the queue (exit 10 on expiry).
- `--no-wait` — fail immediately with exit 11 instead of queueing.
- `--allow-download` — permit downloading a missing runtime / system image
  (multi-GB; never implicit). Without it, a missing runtime is exit 12.
  A platform downloads one component at a time: a lease for a second missing
  runtime on the same platform waits until the running download ends, and
  leases for the same missing runtime share one download. The whole wait,
  queued download included, counts against `downloads.timeoutMs`; running out
  is `DOWNLOAD_TIMEOUT` (exit 10). Through a gateway the flag has no effect.
- `--ttl <duration>` — the lease's initial TTL, replacing
  `lease.defaultTtlMs` (15m) for this lease. Asking for more than
  `lease.maxTtlMs` (4h) is a `BAD_REQUEST` (exit 2), not a silent clamp. See
  [CONFIGURATION.md](CONFIGURATION.md).
- `--export-env` — print the grant's `environment` as shell `export` lines on
  stdout instead of the JSON line, for `eval "$(...)"`. See
  [Reaching a leased device](#reaching-a-leased-device). If the grant carries no
  environment at all (an older daemon), stdout stays empty and a note naming the
  lease id goes to stderr, so the lease can still be renewed or released.

  For iOS, this runs `xcodebuild -downloadPlatform iOS` under the hood and
  only reaches back to iOS 16.0 (a floor of Xcode's own downloader); older
  runtimes and unknown device types (which need a newer Xcode) still require
  installing/upgrading Xcode by hand. A requested `--os` outside the
  device's supported runtime range (e.g. iPhone Xs above iOS 18.x) fails
  immediately — no download is ever attempted for a version that could not
  work regardless. For Android, this runs `sdkmanager --install`; an
  unaccepted SDK license fails naming `downloads.acceptAndroidLicenses`
  (config) unless that flag is set, in which case licenses are accepted
  automatically and the install retried once. Free disk space is checked
  before any install starts, counting the downloads already running on
  either platform, and a download that does not fit fails fast, naming
  required vs. available bytes, instead of risking a full disk mid-download.
  Each download (including a license-triggered retry) emits
  `component.install-started` and then `component.installed` or
  `component.install-failed` on the event bus once, however many leases share
  it (`simlock events --follow`); see [EVENTS.md](EVENTS.md#components). The
  request's own progress stream (below) reports the download as the
  `downloading` stage.
- `--mode <slim|full>` — the device mode this lease asks for. Without it, the
  lease gets the default mode of the worker that serves it (`ios.defaultMode`,
  `full` unless configured). `full` is a guarantee: a `full` lease never gets a
  slim device. `slim` is best effort: on a runtime that cannot be slimmed (an
  iOS runtime older than 18.5, or any Android device) the lease is granted a
  full device. A lease only reuses an idle device of the mode it resolved to,
  so it can wait for a fresh device even while devices of the other mode sit
  idle. Any other value is a `BAD_REQUEST` (exit 2). See
  [CONFIGURATION.md](CONFIGURATION.md#device-mode-slim-and-full) for what a
  slim device leaves out.
- `--detach` — print the lease result (the same JSON shape as the grant line
  below, including `device.mode`) and exit instead of staying
  alive. Nothing then renews the lease on your behalf: keep it with
  `simlock lease renew` before `ttlDeadline`, and end it with
  `simlock release`. From an invocation other than the one granted the
  lease, both of those need an admin credential — see [Admin credential
  resolution](#admin-credential-resolution).
- `--bind-pid <pid>` — only meaningful without `--detach`: watch this pid for
  death instead of the CLI's actual parent. For a holder spawned from a
  short-lived subshell, the immediate parent can die (and get reaped) while
  the owning agent is still very much alive; point this at the agent's own
  pid instead.

One lease per requester in v1: leasing while you already hold a lease or
have a request queued fails with `REQUESTER_ALREADY_LEASED` (exit 13); the
error message names the existing lease id to release first.

**Staying alive (the default):** intended to be run in the background by the
agent. As soon as the device is ready, one JSON line is printed on stdout — the
contract's `lease.request` output (`LeaseGrant`: `device`, `lease`, `timing`)
serialized as-is, plus the one field the CLI adds on top, the connection's
resolved `role`:

The fields you usually care about, from that same line:

```json
{"lease":"lse_9f2c","platform":"ios","device":"iPhone 17 Pro","os":"26.5","udid":"ABCD-...","state":"leased",
 "environment":{"SIMLOCK_IOS_DEVICE_SET":"/Users/you/.simlock/devices/ios"}}
```

The `environment` object is what you need to actually reach the device —
Simlock keeps its devices in roots the platform tools do not look in by
default, so a bare `simctl` or `adb` will not find them. See
[Reaching a leased device](#reaching-a-leased-device).

The full line, with every field the contract defines:

```json
{"device":{"id":"dev_1a2b","driverDeviceId":"ABCD-...","spec":{"platform":"ios","model":"iPhone 17 Pro","osVersion":"26.5"},"address":"...","mode":"slim"},"lease":{"id":"lse_9f2c","deviceId":"dev_1a2b","requesterId":"agent-1","ownerId":"agent-1","grantedAt":1735689600000,"ttlMs":900000,"lastRenewedAt":1735689600000,"ttlDeadline":1735690500000},"timing":{"estimatedProvisionMs":0,"estimatedBootMs":0,"estimatedReclaimMs":0,"estimatedReadyMs":0},"role":"agent"}
```

`lease.ttlDeadline` is the moment the daemon will expire this lease if
nothing renews it. It is the only thing keeping the lease alive — there is
no second mechanism behind it. The lease also stores the `ttlMs` it was
granted with, which is what a renew re-applies unless one names a new TTL.

Then the process stays alive, and while it is alive it does two things for you.
It **renews** the lease every third of the lease's TTL, sending no TTL of its
own, so each renew re-applies the lease's own `ttlMs` and the deadline keeps
moving out at its original width for as long as the process is there. A renew
that fails with a transient error while the connection is still alive is not
fatal — the next tick retries it, and there is a whole TTL of slack to retry
inside. A renew answered `UNKNOWN_LEASE` is different: the daemon has already
ended the lease, so the holder exits `14` exactly as a `lease-lost` push would
have ended it. And it **releases** on the way out: on a normal exit, on
`SIGINT`/`SIGTERM`, and on parent death — it watches its parent (the pid
captured at startup, or `--bind-pid`) and releases and exits on its own the
moment that parent is gone, so a crashed or killed agent's backgrounded `lease`
does not outlive it.

Release-on-exit is this process's own policy, not something the daemon
enforces. A holder that is `SIGKILL`ed, or whose machine disappears, cannot
run it: that lease is not released, and its device stays leased until
`ttlDeadline` — at most the lease's own TTL after its last renew:
`lease.defaultTtlMs` unless the request asked for more, never more than
`lease.maxTtlMs`. If that matters, lower `lease.defaultTtlMs` or pass a
shorter `--ttl`.

**If the connection dies, the lease outlives it but this process does not.**
The CLI never reconnects, so a daemon that stops, crashes, or
has its socket killed leaves the holder unable to renew or release. It writes
one error line naming the lease and its deadline, and exits `1`:

```json
{"error":{"code":"DAEMON_CONNECTION_LOST","message":"lost the daemon connection; lease lse_9f2c is still yours until its ttlDeadline 1735690500000 -- renew it with `simlock lease renew lse_9f2c` or let it expire"}}
```

Nothing was released. The lease is still granted to you on the daemon, still
counting down, and a later `simlock lease renew <lease-id>` picks it straight
back up — from a different invocation only when that invocation resolves an
admin credential (see [Admin credential
resolution](#admin-credential-resolution)), since the lease's owner is the
session that was granted it. This is not exit `14`: `14` means the
daemon ended the lease while the connection was alive, which is a different
thing to have to handle.

`device` is a **projection** of the registry's device record — `id`,
`driverDeviceId`, `spec`, `address?`, `mode` — not the full
record `status.get`/`list.get` return to an admin caller. Internal
bookkeeping fields (`driverData`, `quarantine*`, `foreign*`, `recovering*`,
the derived `transitionAgeMs`) never appear on a grant; a caller that wants
those needs the admin-role `list.get`/`status.get`, not `lease.request`'s
output. `device.mode` is the device mode the granted device actually has:
`"slim"` when its feature set was reduced, and `"full"` otherwise — always
`"full"` for Android. A `--mode slim` lease can report `"full"` (slim is best
effort); a `--mode full` lease never reports `"slim"`. It lets an agent explain a feature-loss failure (missing push notification,
Spotlight result, StoreKit sheet, universal link, or system picker) instead
of misreading it as a bug. See `src/contract/schemas.ts`
(`deviceRecordSchema`, `leaseRecordSchema`, `leaseGrantSchema`) for the full
field list — this is the one vocabulary every frontend (CLI, MCP, HTTP, the
`simlock/client` package) now shares.

Progress streams on stderr and reflects only the action selected for that
request. A queued request reports its position without speculative work stages;
reclaiming work is reported separately:

```json
{"push":"progress","stage":"queued","queuePosition":1}
{"push":"progress","stage":"downloading","component":"26.4","waiting":false,"percent":41}
{"push":"progress","stage":"provisioning","etaMs":90000}
{"push":"progress","stage":"booting","etaMs":60000}
{"push":"progress","stage":"reclaiming","etaMs":34000}
```

`push` is the one field the CLI adds to identify the line's kind; everything
else is the contract's `LeaseProgress` push, serialized as-is.

`downloading` means the request waits on a download that `--allow-download`
started or joined, before any device work. `component` names what is being
downloaded, as the platform names it: an iOS version or an Android API
level, for example. `waiting` is
`true` while another download on the same platform runs ahead of this one,
since a platform downloads one component at a time, and `false` once this
download runs. `percent`, a whole number from 0 to 100, is there when the
platform's installer printed one; it is left out at the start of a download
and for an installer that prints no percentage. A request that joins a
download already running gets the download's latest line at once. A request
that needs no download never sees this stage.

`reclaiming` follows `queued` when the device the request is waiting on is
being purged for its previous holder: the position alone would not say that
the wait is an iOS erase rather than a moment. Every `eta_seconds` comes from
the driver's own estimate for the work it selected, which for a reclaim means
the strategy that clean level uses -- an erase runs tens of seconds, a
snapshot restore a few.

Once granted, a `lease` that stays alive also relays the health monitor's
findings about the leased device for as long as it is connected, on the same
stderr stream:

```json
{"push":"device-unhealthy","leaseId":"lse_9f2c","deviceId":"dev_1a2b"}
{"push":"device-recovered","leaseId":"lse_9f2c","deviceId":"dev_1a2b","attempts":1}
```

`device-unhealthy` means the device stopped running outside simlock and a
reboot is in progress under the same lease; `device-recovered` means that
reboot passed readiness. The lease itself is untouched by either — it is still
yours, still on its TTL, and must still be released the normal way. Recovery
can instead give up (the device vanished, its provenance no longer checks out,
or reboot attempts ran out); giving up is not itself one of these lines — it
ends the lease, which surfaces as the same line any other lease loss does:

```json
{"push":"lease-lost","leaseId":"lse_9f2c","deviceId":"dev_1a2b","reason":"device-lost"}
```

In all three lines `deviceId` is the registry device id — the `id` column of
`simlock list --devices`, and the same identifier the event bus uses — not the
driver-level `udid` the grant returns on stdout. A `lease-lost` line is
terminal for a `lease` that stayed alive: there is no longer a lease to
renew, so the process writes that line and exits `14` rather than waiting for
a signal, and it does not try to release a lease the daemon has already taken
back. `lease-lost` is a push from a live daemon connection — a connection
that simply died is exit `1` and a `DAEMON_CONNECTION_LOST` line instead, and
leaves the lease standing. The `reason` is whatever ended it — `device-lost`
here, but equally `expired` or `killed`. A reboot cannot bring back
anything the agent had running inside
the device (a launched app, `log stream`, an Appium/XCUITest session, a port
forward) is gone whether or not recovery succeeds.

### `simlock lease renew <lease-id> [--ttl <duration>]`

Extend a lease's TTL. Renewal always resets the deadline to now plus the TTL,
regardless of how much time was left.

Without `--ttl`, a renew keeps the lease's own width: the new deadline is now
+ the lease's stored `ttlMs`, the TTL it was granted with or last renewed
with. `lease.defaultTtlMs` is what a *request* falls back to when it names no
`ttlMs`, not what a renew falls back to — a lease granted for four hours does
not quietly shrink to fifteen minutes the first time something renews it.
Passing `--ttl` changes the lease's width from that renew on, capped by
`lease.maxTtlMs` (4h); asking for more is a `BAD_REQUEST` (exit 2). Exit 1 if
the lease is unknown or already expired (error code `UNKNOWN_LEASE`).

Renewing is the only thing that keeps any lease alive, on every transport.
A `simlock lease` left running does it for you on a timer; anything holding a
`--detach` lease has to do it itself, before `ttlDeadline`.

From an invocation other than the one granted the lease, this needs an admin
credential — see [Admin credential
resolution](#admin-credential-resolution). A lease belongs to the session it
was granted to, so a fresh agent-role process renewing someone else's lease
id gets `FORBIDDEN`; the CLI connects as admin whenever the local
`admin.token` file is readable, which is why this normally just works.

## Reaching a leased device

Simlock's simulators live in a device set Xcode does not read, and its
emulators are registered with Simlock's own adb server rather than the shared
one. That is deliberate — it is what stops another tool, or another agent,
from erasing a device out from under you. It also means the usual commands
need to be pointed at the right place.

Every grant carries an `environment` object with what that platform needs:

| Variable | Platform | What it is |
|---|---|---|
| `SIMLOCK_IOS_DEVICE_SET` | ios | Device-set path to pass as `simctl --set` |
| `ANDROID_ADB_SERVER_PORT` | android | Port of Simlock's adb server; `adb` reads it natively |

Two ways to use it.

**Let Simlock inject it** with the `simctl` / `adb` passthroughs below — the
usual choice.

**Or export it yourself**, when something else has to shell out to the real
binary:

```bash
eval "$(simlock lease --platform android --device 'Pixel 8' --detach --export-env)"
adb shell getprop   # now talks to Simlock's server
```

On iOS there is no environment variable `simctl` reads on its own, so exported
or not, the path has to reach the command line:

```bash
xcrun simctl --set "$SIMLOCK_IOS_DEVICE_SET" list devices
```

Both ways describe paths and ports **on the machine that owns the device**.
That is your own machine when you lease from a local worker, and somebody
else's when you lease through a gateway or over HTTP — a device set path from
another Mac is of no use locally, and `--export-env` cannot make it one. When
the device is remote, reach it with `simlock simctl` / `simlock adb`, which
run the command where the device is; see [Against a
gateway](#against-a-gateway).

## `simlock simctl [--lease <lease-id>] <args...>`

Run `xcrun simctl` against Simlock's iOS device set. Every argument is passed
through unchanged with `--set <deviceRoot>` inserted, so the command behaves
exactly as documented by Apple — it just resolves the UDIDs Simlock manages,
which a bare `simctl` cannot see.

`--lease` is only meaningful against a **gateway**, where the device is on
another machine and the command runs through `device.exec`, which is scoped
to a lease; see [Against a gateway](#against-a-gateway). Against a worker it
is unnecessary, and accepted so that one command line works against either.

```bash
simlock simctl install booted ./MyApp.app
simlock simctl io booted screenshot shot.png
```

Refused, all exit 2 with `USAGE` and a message naming what to run instead:

- `create`, `erase`, `delete` — they change a device's lifecycle behind the
  registry's back, so Simlock would report the device as drifted on the next
  reconcile. Use `simlock release` (which reclaims the device for you) or
  `simlock cleanup`.
- `shutdown all` — it stops every device in the set, for every agent, and each
  interrupted lease spends its recovery budget rebooting; one that runs out
  ends as `lease_lost`. `shutdown <udid>` of a single device is allowed.
- `runtime delete` — it deletes a runtime shared with Xcode.
  It does not free the disk the runtime's download
  takes either (see `doctor`'s `runtime-cache-unreclaimable` finding). Delete
  it through Xcode if that is what you mean.
- `--set` and `--profiles`, wherever they appear *before* the subcommand and
  however they are spelled (`-set`, `--set <path>`, `--set=<path>`) —
  `simlock simctl` supplies the device set itself. A caller-supplied one would
  point simctl outside what Simlock manages, and (because their value is a
  separate argument) would let a refused verb read as an ordinary operand. Run
  `xcrun simctl` directly if you mean to leave Simlock's set. Past the
  subcommand they are that subcommand's own operands and are left alone —
  `simlock simctl spawn booted foo --set x` is passing `--set x` to `foo`.

Against a **gateway**, the device is on another machine, so the command runs
there instead — see [Against a gateway](#against-a-gateway). The refusals
above are unchanged, and where they are enforced does not change either:
**the daemon refuses, the CLI reports.** The CLI holds no copy of the refusal
list in either direction — frontends render the contract, and the list lives
with the driver that owns the device. Locally that means
`driver.passthrough` refuses and the CLI relabels the answer as `USAGE`
(exit 2); through a gateway it sends `device.exec` and the worker refuses
with `PASSTHROUGH_REFUSED`, or `UNKNOWN_PASSTHROUGH_TOOL` for a tool it does
not wrap, which the CLI relabels exactly the same way it relabels the local
one. Same exit code, same message, one source of truth — and a caller
reaching `device.exec` over HTTP gets the daemon's own code, unrelabelled.

## `simlock adb [--lease <lease-id>] <args...>`

Run `adb` against Simlock's adb server. Arguments pass through unchanged with
`-P <adbServerPort>` inserted. `--lease` behaves exactly as it does for
`simlock simctl` above.

```bash
simlock adb shell input tap 100 200
simlock adb logcat -d
```

Refused, all exit 2 with `USAGE` and a message naming what to run instead.
The refused *verbs* are matched anywhere in the arguments, so
`-s <serial> emu kill` is caught too:

- `kill-server` — it would detach every leased emulator at once. (Simlock's
  server rejects `kill-server` outright in any case.)
- `emu kill`, `emu avd stop` — they stop a device Simlock believes is
  running, which reports as drift on the next reconcile.
- `emu avd snapshot delete` — it destroys the clean-boot snapshot Simlock
  restores from, turning every later reclaim of that device from a snapshot
  load into a full wipe.

Use `simlock release` (which reclaims the device for you) or `simlock cleanup`
instead. As with `simlock simctl`, against a gateway the command runs on the
worker that owns the device (see [Against a gateway](#against-a-gateway)) and
the refusals above hold on both ends.
Globals — the arguments before the subcommand — are refused by *position*
and by an **allow list**, rather than anywhere on the line or by naming the
ones known to be dangerous:

- Only `-s`, `-t`, `-d`, and `-e` (in every spelling adb accepts, including
  the attached forms `-t123`, and including one that follows another
  global's value, e.g. `-s emulator-5554 -t 1 shell …`) are let through —
  they select a device inside the containment Simlock already established
  rather than escaping it.
  `--version` and `--help` are also let through, since adb answers those on
  its own before it ever looks for a subcommand.
- Everything else positioned there is refused, whether or not it is a flag
  this driver has a name for: `-P`, `-H`, `-L`, `--server-port` (including
  the attached forms `-P5037` and `-Hhost`) are refused because `simlock adb`
  supplies the server itself and `adb` takes the *last* one on the line, so a
  caller-supplied one would silently win and point the command at a server
  that cannot see Simlock's devices (or at one Simlock must not touch); any
  other global — known adb globals this driver has no reason to allow
  (`-a`, `--exit-on-write-error`, `--one-device`, the undocumented
  `--reply-fd`) as well as any global a future adb release adds — is refused
  the same way, on the principle that an argument whose effect on the command
  this driver cannot vouch for is refused rather than assumed harmless.

From the subcommand onwards those spellings are operands and pass through:
`simlock adb shell echo -Please` echoes a word. Run `adb` directly if you
mean to leave Simlock's server.

## `simlock release <lease-id> | --all`

Explicitly release a lease (primarily for a `--detach` lease or for operator
intervention). `--all` force-releases every lease — confirmation required
unless `--yes`.

Release returns as soon as the lease is gone, not when the device is clean.
Giving up the lease is a registry commit; wiping the device behind it is a
driver operation that can run tens of seconds (an iOS `simctl erase`), and it
proceeds in the background once the command has already exited. The same holds
for a lease released by its holder exiting, and for `release_simulator`
over MCP — an agent gets its turn back immediately instead of waiting on a
device it has already given up.

What that means for the next command: the device is `reclaiming` for a moment
after `release` returns, so it still counts as running capacity and is not
grantable yet. A `lease` request that wants it simply queues and is granted the
instant the purge finishes; nothing is lost, but `status` right after a release
will show `reclaiming` rather than `ready`. `simlock daemon stop` waits for
in-flight purges before exiting, so a graceful shutdown still leaves the pool
settled; a daemon killed mid-purge leaves its devices `reclaiming` for the next
startup to recover.

## Against a gateway

A **gateway** is a simlock daemon that owns no devices and fronts the workers
that joined it (see
[CONFIGURATION.md](CONFIGURATION.md#modes-gateway-and-worker) for `mode` and
the keys each side reads). Point the CLI at one the way you point it at any
daemon: `SIMLOCK_HOME` selects the data directory, and the daemon socket in
it is what the CLI connects to. **The commands do not change.** A gateway
implements the same contract a worker does, so this whole document still
applies; what follows is only the handful of places where you can tell.

The CLI speaks the unix socket and nothing else — it has no HTTP transport
and no `--url`, so "point the CLI at a gateway" means running it on the
gateway's own machine (or wherever that socket is), typically as the
operator. An agent on another machine reaches the fleet over the
[HTTP API](HTTP-API.md), which is what the gateway is listening on and what
that API exists for. Both get the identical contract; only the transport
differs.

**Leasing is identical.** `simlock lease` takes the same flags and prints the
same grant line, including `--ttl`, `--no-wait`, `--timeout`, and
`--allow-download`, which is accepted and has no effect through a gateway:
only runtimes already installed on a worker count, and no download is
started. The request waits in the gateway's own fleet-wide FIFO queue,
reporting `queued` with a `queuePosition` exactly as a worker's queue does.

The gateway sends a request only to a worker that can serve it. `--device`
matches a worker's model in any letter case and by any other name that
worker's catalog lists for it, such as an Android AVD id (`pixel_7`). When
`--os` is given, the worker must pair that runtime with the model; without
it, the model must pair with at least one installed runtime. A worker that
has the model and the runtime but cannot pair them is passed over. Among the
workers that can serve it, the request goes to a machine with a matching warm
device first, otherwise the one with the most free capacity. You do not name a machine and there is no flag to; where
a device lives is the gateway's decision.

The grant carries one additional block so you can see where it landed:

```json
{"lease":{"id":"3f81a2c4.lse_9f2c","worker":{"id":"3f81a2c4","label":"mac-studio-2"}}}
```

The lease id names its worker (that is how renew, release, and reads route
with no gateway-side state to lose), but it is **opaque** — do not parse it.
`worker.label` is display-only.

**`lease renew`, `release`, and lease reads are forwarded** to the worker
that owns the lease, and the `ttlDeadline` you see is that worker's own.
Leases are TTL-first on every transport, so a gateway emulates
nothing: a `simlock lease` left running renews on its timer as always, and a
client that stops renewing loses the lease on the worker's clock whether or
not a gateway is in the path.

**One lease per requester is fleet-wide.** Leasing while you already hold a
gateway-issued lease on *any* worker in the fleet is `REQUESTER_ALREADY_LEASED`
(exit 13) naming that lease, the same rule and the same code as on one
machine.

One thing an operator sees only from the other side: the requester id the
gateway forwards to a worker is **namespaced**,
`gw:<gateway instance id>:<requester>`. So `simlock status` on the *worker*
shows a fleet lease as `gw:7c1e…:agent-1` while the gateway shows it as
plain `agent-1`. That is what keeps a local `agent-1` on that machine and a
remote `agent-1` behind the gateway from colliding on the worker's own
one-lease rule — and it means a lease's attribution says which fleet it came
from, not just who asked.

**`simlock status` and `simlock list`** answer for the whole fleet: capacity
summed over connected workers, every lease and device carrying the
`workerId` it lives on, the gateway queue's depth — plus a `workers` block,
one entry per worker view, which is what `simlock worker list` prints on its
own. `status`'s daemon block carries `mode` (`"worker"` or `"gateway"`); that
field is the only way a client tells the two apart.

**`simlock release --all`** releases only the leases **this gateway
issued**, on every connected worker, and never a worker's own local ones: the
gateway did not issue those, does not know who holds them, and taking a local
developer's device away from an endpoint they have never heard of is not an
operator action anyone asked for. A worker it cannot reach is reported as
`WORKER_UNREACHABLE` naming that worker while the reachable workers' leases
are still released — a partial result stated plainly beats an all-or-nothing
that leaves you guessing. Confirmation is still required unless `--yes`.
Releasing a single lease by id is unchanged.

**`simlock catalog`** is the union of the workers' catalogs, each model and
runtime annotated with the workers that have it — so a `--device` the
catalog lists is leasable *somewhere*, not necessarily everywhere. A model is
paired with a runtime when at least one connected worker pairs them itself;
one worker having the model and another having the runtime does not make a
pair. `simlock worker list --json` shows each worker's own pairings. A
request goes only to a worker that pairs the model with the runtime.

**`simlock events`** shows the fleet: every worker's business events are
republished on the gateway's bus with `workerId` added to the payload,
alongside the gateway's own `worker.*` and `request.dispatched` facts (see
[EVENTS.md](EVENTS.md)). `--follow` and `--since` work as always, over the
gateway's own event history.

**`simlock simctl` and `simlock adb`** keep working, but not the same way
underneath. Against a **worker** they behave exactly as documented above: the
daemon resolves a root-scoped command through `driver.passthrough` and the
CLI spawns it locally with inherited stdio, so an interactive `adb shell` is
still an interactive `adb shell`. Against a **gateway** the device is on
another machine, so the CLI sends `device.exec` instead and prints the output
it streams back — stdout to stdout, stderr to stderr, as it arrives — exiting
with the tool's own exit code.

The CLI picks between the two by reading `mode` off `status.get`, which it
already calls: `gateway` means `device.exec`, anything else means
`driver.passthrough`. It is not guesswork and not a flag — the daemon says
what it is, and there is exactly one thing to branch on. (A remote agent
reaches the same operation as `POST /v1/leases/{id}/exec`; see
[HTTP-API.md](HTTP-API.md).) Three consequences:

- **It needs a lease**, because `device.exec` is scoped to one. The CLI uses
  your own lease, which the one-lease-per-requester rule makes unambiguous;
  `--lease <lease-id>` names one explicitly (and is required if you hold none
  under the identity you are running as — see [Agent
  identity](#agent-identity)). An **agent-role** invocation sends no
  `requesterId` at all and is gated the ordinary way, its principal against
  the lease's `ownerId`, exactly as `lease renew` and `release` are. An
  **admin-role** one — the usual case, since the CLI connects as admin
  whenever `admin.token` is readable — sends its resolved agent id as
  `requesterId`, because on this one operation **admin does not bypass the
  ownership check** and the worker compares that id to the lease's own. So
  `simlock simctl --lease <someone else's lease>` fails even from an
  admin-credentialed CLI; set `--agent-id`/`SIMLOCK_AGENT_ID` to the identity
  that holds the lease if you mean to drive that device.
- **There is no pseudo-terminal.** Line-oriented commands work; full-screen
  ones do not. If stdin is a pipe or a file, the CLI reads it to EOF *before*
  sending, and it travels as the request's one `stdin` string, written to the
  process and then closed — so `echo hello | simlock adb shell cat` works and
  an interactive `adb shell` does not, because there is no channel to type
  into once the request has gone. That last case does not hang waiting to
  find out: the worker refuses a bare `adb shell` with no command outright,
  `PASSTHROUGH_REFUSED` (exit 2) and a message saying it needs a terminal,
  rather than starting a session nobody can type into and letting it sit
  there for ten minutes until `EXEC_TIMEOUT`.
- **A command that outlives `exec.timeoutMs`** (10 minutes, worker-side and
  authoritative) is killed and the command fails with `EXEC_TIMEOUT`
  (exit 10). Output is streamed, never buffered, so there is no size cap.

Files do not travel with the command: `simctl install <path>` and `adb
install <apk>` resolve their path on the **worker's** filesystem, so the
artifact has to be there already (a shared volume, a CI checkout on that
machine).

**Three commands refuse outright**, with `UNSUPPORTED_IN_GATEWAY_MODE` (exit
2): `simlock nuke`, `simlock cleanup`, and `simlock doctor`. Each acts on one
machine's devices as a whole, and in v1 they stay per-worker, direct
operations — run them against that worker's own daemon. A fleet-wide
destructive command from one endpoint is not something v1 offers.
`driver.passthrough`, the operation behind the *local* form of `simlock
simctl` / `simlock adb`, answers the same way for the same reason: a
root-scoped command string naming a device set on another machine is
something the client cannot run, and handing it one would be worse than an
error. That is why those two commands switch to `device.exec` here rather
than failing.

**`simlock component install` needs workers named.** A gateway owns no
components, so without a flag the command answers
`UNSUPPORTED_IN_GATEWAY_MODE` (exit 2) and says to name workers. With
`--worker <id>` (repeatable) or `--all-workers`, it asks each of those
workers to install the component, all at the same time, and reports one
result per worker. Each worker decides for itself under its own
`downloads.policy`; the gateway has no download policy of its own. See
[On a gateway's workers](#on-a-gateways-workers).

`simlock config get` on a gateway returns the gateway's own configuration,
not any worker's. `simlock daemon <start|stop|status|logs>` manages the
gateway process itself, exactly as it manages a worker's.

**When a worker is unreachable** — its uplink is down — anything routed to it
fails with `WORKER_UNREACHABLE` (exit 1, `kind: "transport"`): a renew, a
release, a `simctl`/`adb`, or a request that had already been dispatched to
it. The gateway does not guess that the lease is gone; the worker's own TTL
ends it on the worker's clock, and the loss reaches you once the uplink is
back. The recovery is the ordinary one: re-request, and if the worker had in
fact granted you a lease, the fleet-wide one-lease rule names it once the
gateway has rebuilt its index.

## `simlock worker <list|drain|undrain|remove>`

Operator commands for the workers connected to a **gateway**. All four need
the `admin` role (see [Admin credential
resolution](#admin-credential-resolution)). A worker has no workers of its
own, so it does not implement these operations at all and answers
`UNKNOWN_REQUEST` — they are not a gateway-mode refusal of something a worker
could otherwise do, they are simply not part of a worker's surface. `list`
prints one line per worker, or the views as JSON with `--json`; `drain`,
`undrain` and `remove` print JSON on stdout, unconditionally — `--json` is a
usage error (exit 2) for those three.

```
simlock worker list
simlock worker drain <worker-id>
simlock worker undrain <worker-id>
simlock worker remove <worker-id>
```

`list --json` prints one worker view per connected-or-remembered worker. This
one is a real answer from a test fleet whose drivers are simulated, which is
why its Android catalog looks thin, trimmed to one worker:

```json
{
  "workers": [
    {
      "id": "2b026432-7743-4a08-98fc-ce494d11866f",
      "label": "worker-a",
      "connection": "connected",
      "drained": false,
      "lastSeenAt": 1790864080506,
      "health": "running",
      "version": "1.0.0",
      "capacity": {
        "ios": {
          "running": 0,
          "maxRunning": 8,
          "reserved": 0,
          "overLimit": false,
          "limit": 8,
          "warm": 0,
          "used": 0
        },
        "android": {
          "running": 0,
          "maxRunning": 8,
          "reserved": 0,
          "overLimit": false,
          "limit": 8,
          "warm": 0,
          "used": 0
        },
        "global": {"running": 0, "maxRunning": 8, "reserved": 0, "overLimit": false, "warm": 0}
      },
      "downloads": {"policy": "on-request", "timeoutMs": 1200000},
      "lease": {"maxTtlMs": 14400000},
      "queueDepth": 0,
      "leases": [],
      "devices": [],
      "installs": [
        {"platform": "ios", "component": "26.4", "state": "downloading", "since": 1790864071200, "waiters": 1}
      ],
      "catalog": [
        {
          "platform": "ios",
          "models": ["iPhone 16"],
          "runtimes": ["18.4", "26.0"],
          "defaultRuntime": "26.0",
          "modelRuntimes": {"iPhone 16": ["18.4"]},
          "modelAliases": {}
        },
        {
          "platform": "android",
          "models": [],
          "runtimes": ["18.0"],
          "defaultRuntime": "18.0",
          "modelRuntimes": {},
          "modelAliases": {},
          "images": [{"runtime": "18.0", "tag": "google_apis", "abi": "arm64-v8a"}]
        }
      ],
      "host": {
        "os": "macOS",
        "osVersion": "26.6.1",
        "arch": "arm64",
        "tools": [{"platform": "ios", "name": "xcode", "version": "16.4", "build": "16F6"}]
      }
    }
  ]
}
```

`downloads.policy`, `downloads.timeoutMs` and `lease.maxTtlMs` are that
worker's own effective config, read when its uplink connects, again on every
periodic refresh, and after the worker installs a component.
The policy is shown for reference; routing does not read it, since no
download is started through a gateway. `installs` lists the
component installs waiting or running on that worker, whoever started them,
in the shape [`simlock status`](#simlock-status) describes. It is re-read
when an install on that worker starts, finishes or fails, and on every
periodic refresh, so an install queued behind another may appear only then.
A disconnected or incompatible worker lists none. `catalog` is what that
worker can lease, each model with the runtimes it pairs with, and lists a
newly installed component as soon as its install ends. `host` is the
machine: operating system, its version, CPU architecture, and the version of
each platform tool its drivers use (`xcode` with its build; the Android
`emulator`, `platform-tools` and `cmdline-tools`). A tool the worker does not
have is left out. `protocol` appears only on an `incompatible` worker and
names both ranges, the worker's and the gateway's, so you can see which side
to upgrade. Worker ids are UUIDs; the console example below shortens them to fit.

`connection` is `connected`, `disconnected`, or `incompatible`. A **disconnected**
worker keeps its last-known view (nothing is dispatched to it) until an
operator removes it or `gateway.disconnectedRetentionMs` (24 hours) elapses.
The retention clock is held while the gateway still knows of gateway-issued
leases on that worker — forgetting a worker that holds someone's device is
how a lease becomes unroutable — and that hold ends when the **last of those
leases passes its deadline**, since a lease the gateway cannot renew is one
the worker has expired on its own clock. A worker gone longer than every
lease it held is a worker with nothing left to protect.

An **incompatible** worker is one whose protocol range does not overlap the
gateway's; its view shows both ranges and it is never dispatched to, but it
is not hidden — that is the machine an operator has to go and upgrade, and it
still serves its own local clients fine.

`drain` is how a machine is taken out of service without killing anyone's
device: a drained worker **keeps its existing leases** and receives no new
dispatches. Wait for its leases to end (`simlock status` shows them), then do
the maintenance. `undrain` puts it back in rotation.

Draining sticks until you undrain it. It is your intent about that machine,
not something read off it, so it lives in the gateway's **worker registry** —
the one piece of gateway state that is persisted (a small file under the
gateway's `SIMLOCK_HOME`, owner-only) as opposed to the worker *view*, which
is rebuilt on every connect. A drained worker that restarts comes back
drained, and so does one whose *gateway* restarted. Nothing but `undrain`
puts a machine back in rotation, which is the point: an operator who drained
a worker and walked away should not have a process they never touched undo
it.

`remove` forgets a worker. A worker whose uplink is still open is refused
with `WORKER_CONNECTED` (exit 2) — a connected worker would simply reappear,
so removing one is a request that cannot mean what it says; drain it and stop
its daemon (or revoke its join token, which closes the uplink) first.

On a worker the gateway knows, all three print the resulting state:

```json
{"workerId":"3f81a2c4","drained":true}    // drain
{"workerId":"3f81a2c4","drained":false}   // undrain
{"workerId":"3f81a2c4","removed":true}    // remove
```

For an id the gateway does **not** know they diverge, deliberately:

- `drain` and `undrain` **fail** with `UNKNOWN_WORKER` (exit 12). Draining is
  an instruction about one specific machine, usually typed just before
  someone walks over to it; succeeding silently against an id that is not
  there would hide a typo in exactly the moment an operator most needs to
  know the instruction landed.
- `remove` **succeeds** with `{"removed":false}`, the way `token revoke`
  answers for an unknown token id. "Forget this worker" is already true of a
  worker the gateway has already forgotten, so there is nothing to report
  and nothing for a script to special-case on a re-run.

A worker is never *added* by a command. It appears by connecting: mint a join
token on the gateway with `simlock token create --role worker`, put it in the
worker's `gateway.token` alongside `gateway.url`, and start it. `simlock
token revoke <token-id>` closes any uplink that token opened.

## `simlock mcp`

Start Simlock's local stdio MCP server. It accepts no flags. Standard output is
reserved for MCP JSON-RPC; fatal diagnostics are written to stderr. The server
exposes the focused `list_devices`, `lease_simulator`, `release_simulator`, and
`lease_status` tool surface for one agent session. The server auto-starts the
daemon when needed, on a tool call; its renew timer reconnects only to a
daemon that is already listening, and never launches one. `lease_simulator`
accepts the contract's optional `ttlMs` — defaulting to `lease.defaultTtlMs`
and `BAD_REQUEST` above `lease.maxTtlMs`, the same rule every other frontend
gets — and the session renews that lease on a timer and releases it when the
process ends, the same policy `simlock lease` follows. If that session's lease ends elsewhere (expiry or a force-release),
the server relays it as an MCP logging notification. A `lease_simulator` call
that carries a `_meta.progressToken` gets queue/provisioning/boot progress
relayed as MCP `notifications/progress` for that request. See
[../README.md](../README.md#mcp-integration-optional) for details.

The requester identity for leases made through this server is
`SIMLOCK_AGENT_ID`, then the agent tool's session id, then a pid-derived
value — see [Agent identity](#agent-identity). Under Claude Code the server
gets the session's id with no setup, the same id the CLI resolves in that
session. Codex starts MCP servers without its own environment variables, so
under Codex the server cannot see the session id: it falls back to a
pid-derived requester, which differs from the id the CLI resolves in the same
Codex session. An agent that leases through both the CLI and MCP in one Codex
session can therefore hold two leases. To avoid that, use one interface per
session, or set the same `SIMLOCK_AGENT_ID` for both. Under any other client,
set a distinct `SIMLOCK_AGENT_ID` per MCP server process (one per agent
session) so the one-lease-per-agent rule is meaningful.

### Breaking in 0.3.0: tool schemas are now the contract's own field names

Tool names are unchanged. Every tool's input/output schema is now derived
directly from `src/contract`'s zod schemas (`src/mcp/contracts.ts`) instead
of a hand-maintained snake_case shape — one vocabulary across CLI, MCP,
HTTP, and `simlock/client`, not a fourth one. Two changes in here are easy
to miss and will silently produce wrong behavior if you don't update a
caller:

- **`lease_simulator`'s `timeout_seconds` is now `timeoutMs`.** This is a
  rename, not a silent unit change: every tool input schema is
  `.strict()` (`src/contract/operations.ts`), so a caller that keeps
  sending the old `timeout_seconds` key gets a hard `BAD_REQUEST` — loud,
  immediate, and impossible to miss. The real, narrower hazard is a caller
  that migrates the field *name* but not its *value*: sending
  `{"timeoutMs": 30}` meaning "30 seconds" (the old convention) is valid
  input, so nothing rejects it — the request just times out in 30
  milliseconds instead of 30 seconds, roughly 1000× *sooner* than intended,
  not longer. That surfaces immediately as `QUEUE_TIMEOUT` (CLI exit code
  10), not as a silent hang, but it can still read as "the daemon is
  broken" rather than "my timeout value is three orders of magnitude too
  small" unless you know to check the unit. Update every caller's timeout
  field name *and* multiply its value by 1000.
- **The top-level `slim: boolean` on a grant is gone; it's now
  `device.mode`** (`"slim"` or `"full"`, always `"full"` for Android). A
  caller checking `result.slim === true` now silently never sees a
  feature-loss signal at all — `result.slim` is simply `undefined` on every
  response, which is falsy, not an error. Check `result.device.mode ===
  "slim"` instead.

Every other field keeps the contract's own camelCase names it already had
under the pre-0.3.0 hand-written schemas (`leaseId`, `deviceId`,
`allowDownload`, `requesterId`, ...); those did not change shape, only their
schema's source of truth.

## `simlock status`

Human and JSON status include derived warm counts globally and per platform.
`ready` devices contribute to those counts; `reclaiming` and `quarantined`
devices remain visible as busy running capacity and never contribute to warm
inventory. A `quarantined` device is one whose release-time purge failed, one
created under `lease.identity` `fresh` whose lease-end delete failed (it is
retried as a delete, never returned to the pool), or one
whose `provisioning`/`reclaiming` transition stalled past its driver-derived
threshold (see `simlock doctor` below): it stays visible in `status` and
`list --devices` with that state while `QuarantineCoordinator` retries it in
the background, and is never handed to a new requester.

A device currently `provisioning` or `reclaiming` carries a derived
`transitionAgeMs` — how long it has been in that state — visible in `status`
and `list --devices` well before it crosses the threshold that would make
`doctor` flag it as stalled.

Human-oriented overview: daemon health *and mode*, the host it runs on
(`Host: macOS 15.5 arm64; xcode 16.4 (16F6), emulator 35.4.9`), managed capacity
(used/limit per platform), running and reserved capacity (globally and per
platform), the RAM budget (`RAM budget: 4.50 GiB/12.00 GiB used`), every
managed device with its state and device mode
(`Device dev_7: ready, mode slim`), current leases (who — the agent
id, see [Agent identity](#agent-identity) — since when, and when each was last
renewed), the component installs in progress, and queue depth. `--json` for
the structured equivalent. `overLimit`
is true when a lowered limit cannot yet be met, for example because active
leases consume all running slots.

Each install in progress gets one line: platform, component, state, how long
since it was first asked for, and how many requests wait on it
(`Install ios 26.4: downloading for 42s, 2 waiters`). Every install is
listed, whoever started it, for example a lease request with
`--allow-download`. `downloading` means the platform's installer is running;
`waiting` means it is queued behind another install on the same platform, or
about to start. A line goes away as soon as its install ends, whether it
succeeded, failed or timed out. In `--json` the list is `installs`, oldest
first, at most 16 entries: `platform`, `component` (the version, or the word
the platform uses for its newest), `state`, `since` (milliseconds since the
epoch) and `waiters`. It is empty when nothing is installing.

The RAM budget line appears only under the `resource` capacity strategy
(see [CONFIGURATION.md](CONFIGURATION.md#capacity-strategies)); under
`fixed` there is none. In `--json` it is `capacity.ramBudget`:
`limitBytes` (the machine's RAM minus 4 GiB left for the OS), `usedBytes`
(the sizes of every listed device that is not deleted, each by its mode) and
`overLimit`. The line reads `(over limit)` when the use is past the limit,
for example after a restart with larger per-device sizes; until a device
is deleted, none is created, and no shut-down slim device boots if its slim
size is smaller than the full size.

Against a **gateway** (`config.mode: "gateway"`) the same command
answers for the whole fleet, in the same shape: the daemon line reads
`running (gateway)`, capacity is summed across the connected workers (the RAM
budget over those that report one, over its limit when any worker is), one line
per worker precedes the devices, and every device, lease and install names the
worker it lives on (`Device dev_7 on wrk_a: leased, mode full`,
`Install ios 26.4 on wrk_a: waiting for 3s, 1 waiter`). Installs are listed
for the connected workers, the 16 oldest across the fleet. `--json` gains a `workers` array of
[worker views](#simlock-worker-listdrainundrainremove) and a `workerId` on each
device, lease and install; `daemon.mode` says which kind of daemon answered.

The daemon block carries `mode` (`"worker"` or `"gateway"`) — the one field
that tells a client which kind of daemon answered. Beside it, `host` says
what machine the daemon runs on: `os`, `osVersion`, `arch`, and `tools`, one
entry per platform tool its drivers use with the `platform`, `name`,
`version` and, for Xcode, `build`. Tool versions are read when the daemon
starts and again in the background once a minute has passed, so `status`
never waits for them. Right after a start, or for a tool that is not
installed, `tools` has no entry; if a later read fails, the last version read
stays. A gateway runs no drivers, so its own `host` has no
tools; each worker's is on its worker view. Do not confuse it with each
device's own `mode`, the device mode (`"slim"` or `"full"`). Against a **gateway** the
same view is the fleet's: capacity summed over the connected workers, every
lease and device tagged with the `workerId` it lives on, the gateway queue's
depth, plus a `workers` array of worker views (the same records
[`simlock worker list`](#simlock-worker-listdrainundrainremove) prints). See
[Against a gateway](#against-a-gateway).

## `simlock list [--devices|--leases|--rules]`

Scriptable listings of managed devices, active leases, or registered cleanup
rules. Defaults to `--devices`. Against a gateway, `--devices` and `--leases`
are the fleet's (each record naming its `workerId`) while `--rules` lists
nothing at all: cleanup rules run where the devices and the reaper are, and a
gateway has neither. Each lease record's `requesterId` is the
agent id (see [Agent identity](#agent-identity)) that holds it, and its
`lastRenewedAt` is when the lease was last renewed (set at grant, then on
every renew) — the same field `status` renders as "last renewed". Each device
record carries its device mode, `mode`: `"slim"` or `"full"`.

Against a gateway, `--devices` and `--leases` list the whole fleet with a
`workerId` on every row. The device rows are the narrower shape `status`
returns rather than a worker's full registry records: a gateway has never held
a device's driver address or a driver's private data, and does not invent one.
`--rules` lists nothing on a gateway — cleanup rules are a machine's own
configuration, and a gateway runs no reaper.

## `simlock catalog [--platform <ios|android>] [--json]`

Lists what can actually be leased, so an agent can pick a valid `--device`
and `--os` without a failed round trip through `lease`. For each available
platform: the resolvable device models, the runtimes / system images already
installed, which installed runtime is the default (the newest), and for each
model the installed runtimes it pairs with (`modelRuntimes`). A model and a
runtime that are both listed can still fail to pair — on iOS, a runtime can
drop an older model — so pick a pair from `modelRuntimes`. A model with an
empty list pairs with nothing installed. On Android every model pairs with
every installed API level.

`modelAliases` lists, for a model, the other names `--device` accepts for it
on that machine; a model with no other name has no entry. On Android a
built-in profile answers to its AVD id as well as its display name, so
`--device pixel_8` asks for `Pixel 8`. Any listed name works in any letter
case. On iOS a device type answers to its name only, so iOS lists none.
Android also lists `images`: every installed system image with its API
level (`runtime`), tag, and ABI. An image whose ABI the host cannot run
natively is listed too, with its ABI.

`customModels` lists the models that exist because of something on that
machine rather than the platform's tools. The field is absent when there are
none, and iOS never has it. See [Where Android models come
from](#where-android-models-come-from).

A
platform whose SDK is missing (e.g. Android without `ANDROID_HOME` on a
non-macOS host, or iOS off macOS) is omitted rather than erroring the whole
command. `--platform` narrows to one platform. Read-only: this never
downloads a runtime or system image, and lists only what is installed,
whatever `downloads.policy` says.

Human-oriented by default, one line per model with the runtimes it pairs
with, its other names on the line below it, and then each image:

```text
Platform: android
  Runtimes: 34, 35 (default: 35)
  Models:
    My Tablet (custom): 34, 35
    Pixel 8: 34, 35
      Other names: pixel_8
  Images (runtime, tag, ABI):
    34 default x86_64
    35 google_apis arm64-v8a
```

`--json` for the structured equivalent:

```json
{"platforms":[{"platform":"android","models":["My Tablet","Pixel 8"],"runtimes":["34","35"],"defaultRuntime":"35",
  "modelRuntimes":{"My Tablet":["34","35"],"Pixel 8":["34","35"]},
  "modelAliases":{"Pixel 8":["pixel_8"]},
  "customModels":["My Tablet"],
  "images":[{"runtime":"34","tag":"default","abi":"x86_64"},{"runtime":"35","tag":"google_apis","abi":"arm64-v8a"}]}]}
```

Against a gateway, `modelAliases` is the union of each worker's other names
for a model, and `images` the union of their images. A model is in
`customModels` when any worker that lists it marks it custom;
`simlock worker list --json` shows which worker that is. The gateway does not
yet route by another name, so ask a gateway for a model by its name in
`models`.

### Where Android models come from

Simlock reads Android device models from two places and writes to neither:

- **Built-in profiles** ship with the Android SDK's `cmdline-tools`: the
  ones `avdmanager list device` prints. A model newer than your
  `cmdline-tools` is not there; update `cmdline-tools` to get it.
- **Custom profiles** are the ones you make with Android Studio's device
  manager. Android Studio keeps them in `devices.xml` in your `.android`
  directory. A custom profile exists only on the machine where it was made,
  so in a fleet only the worker that has it can lease it. To add one, create
  it with Android Studio's device manager on that machine.

When a name is in both, the built-in profile wins and the model is not
custom. If `devices.xml` cannot be read, the built-in models are still
listed. A custom model is marked `(custom)` in the human view of `simlock
catalog` and listed in `customModels` in `--json`.

## `simlock component install <ios|android> <version> [--worker <id>... | --all-workers]`

Installs one iOS simulator runtime or Android system image, without leasing
a device. Use it to prepare a machine before agents need the component,
instead of making the first lease wait for a multi-GB download.

```sh
simlock component install ios 26.4      # the iOS 26.4 simulator runtime
simlock component install android 35    # the system image for API level 35
```

`<version>` is the string `simlock catalog` lists under `runtimes` once the
component is installed. Admin only: an agent session gets `FORBIDDEN`.

Progress is JSON lines on stderr, the result one JSON line on stdout:

```text
{"stage":"waiting"}                        (stderr: another download on this platform runs first)
{"stage":"downloading","fraction":0.41}    (stderr)
{"platform":"android","component":"35","outcome":"installed","version":"35"}
```

`outcome` is `installed`, or `already-installed` when the component was
already there; running the command again changes nothing and succeeds.
`version` is the exact version installed. `fraction`, from 0 to 1, is
present when the platform's installer reports one. The installed component
appears in `simlock catalog` at once.

- **Consent.** The command is the consent to download, so no
  `--allow-download` is needed. Under `downloads.policy: "never"` it fails
  with `DOWNLOADS_DISABLED` (exit 12) and downloads nothing. Android
  licenses stay their own switch, `downloads.acceptAndroidLicenses`. See
  [CONFIGURATION.md](CONFIGURATION.md#downloads).
- **One download per platform.** A command for another component on the same
  platform waits its turn (`{"stage":"waiting"}`). A command or lease
  request for the component already downloading joins that download, and
  each one gets its result.
- **Time.** `downloads.timeoutMs` counts from the moment the command is
  made, waiting included; running out is `DOWNLOAD_TIMEOUT` (exit 10).
- **Disk.** Too little free disk fails before the download starts, with
  `INSUFFICIENT_DISK_SPACE` (exit 12).
- **Stopping.** Stopping the daemon ends the install; nothing resumes it.
  Run the command again.
- **Gateway.** A gateway owns no components. Without a worker flag it
  answers `UNSUPPORTED_IN_GATEWAY_MODE` (exit 2) and says to name workers;
  see below.

The command takes no `--json`: its output is already JSON, so the flag is a
usage error (exit 2), as is a missing or extra argument or a platform other
than `ios` or `android`.

### On a gateway's workers

Against a gateway, name the workers to install on: `--worker <id>`, once per
worker, or `--all-workers`. Giving both is a usage error (exit 2). The ids
are the ones `simlock worker list` shows.

```sh
simlock component install android 35 --all-workers
simlock component install ios 26.4 --worker 3f81a2c4 --worker 9b07de11
```

Every targeted worker is asked at the same time, and each one installs the
component itself, exactly as if the command had run on that machine: its own
`downloads.policy`, Android license setting, disk check and
`downloads.timeoutMs` apply. A worker set to `downloads.policy: "never"`
refuses. One worker's failure does not stop the others. A drained worker is
asked like any other: draining stops new leases, not maintenance.

Progress lines on stderr name the worker they came from. The result is one
JSON line on stdout with one entry per worker, in ascending worker id:

```text
{"stage":"downloading","fraction":0.41,"workerId":"3f81a2c4"}    (stderr)
{"results":[{"workerId":"3f81a2c4","label":"mac-studio-2","outcome":"installed","version":"35"},{"workerId":"9b07de11","outcome":"refused","error":{"code":"DOWNLOADS_DISABLED","message":"Downloads are disabled by configuration: downloads.policy is \"never\""}}]}
```

| `outcome` | Meaning |
|---|---|
| `installed` | the worker installed the component; `version` is the exact one |
| `already-installed` | the worker already had it |
| `refused` | the worker's `downloads.policy` is `"never"` |
| `failed` | the worker answered with an error; `error.code` is the worker's own (`DOWNLOAD_TIMEOUT`, `INSUFFICIENT_DISK_SPACE`, …) |
| `skipped` | `--all-workers` only: the worker could not be asked — it is disconnected, speaks an incompatible protocol, or the gateway has not read its config yet |
| `unknown` | the worker's connection dropped during its install, or it did not answer within its own `downloads.timeoutMs` plus one minute; the install carries on on the worker |

Every outcome but `installed` and `already-installed` carries
`error: {code, message}`. The command exits `0` when every worker ended
`installed` or `already-installed`, and `15` otherwise.

- **Named workers are checked first.** An id the gateway does not know fails
  the whole command with `UNKNOWN_WORKER` (exit 12), and a named worker that
  cannot be asked fails it with `WORKER_UNREACHABLE` (exit 1). Either way no
  worker is asked.
- **Nothing is kept for later.** A skipped worker is not asked when it comes
  back, and nothing is retried. Run the command again.
- **After an `unknown`.** The worker finishes its install on its own. Once
  it is connected again, `simlock catalog` shows whether the component is
  there; running the command again reports `already-installed` for it.
- **The catalog.** A worker's new component appears in the gateway's
  `simlock catalog` by the time the command prints its result, unless the
  gateway could not read that worker's catalog just then (its connection
  dropped, or it did not answer); the gateway's next read of it brings the
  component in.
- **While it runs**, `simlock worker list` shows the install under each
  worker that is installing.
- The gateway never downloads, stores or forwards a runtime or system image
  itself.

## `simlock component list [--platform <ios|android>]`

Lists every iOS simulator runtime and Android system image installed on the
machine, whoever installed it. Read it before you remove anything. Any
session may run it, an agent session included. It changes nothing.

```sh
simlock component list
simlock component list --platform android
```

The output is one JSON object on stdout:

```json
{
  "components": [
    {
      "platform": "android",
      "version": "35",
      "variant": "google_apis/arm64-v8a",
      "sizeBytes": 4201234567,
      "installedBySimlock": true,
      "installedAt": 1790864071200,
      "devices": 2,
      "foreignDevices": 0
    },
    {
      "platform": "ios",
      "version": "26.4",
      "variant": "23E244",
      "sizeBytes": 9103456789,
      "installedBySimlock": false,
      "devices": 1,
      "foreignDevices": 3
    }
  ]
}
```

Entries are ordered by platform, then version, then variant.

- `version` is the string `simlock catalog` lists under `runtimes`.
- `variant` tells two components of one version apart: the build of an iOS
  runtime, or the tag and ABI of an Android image.
- `sizeBytes` is the disk the component takes. It is left out when it cannot
  be read.
- `installedBySimlock` is `true` only for a component installed through
  Simlock (`component install`, or a lease with `--allow-download`) that is
  still the same one on disk. A component that was there before, or that was
  deleted and installed again some other way, is `false`. `installedAt` is
  when Simlock installed it.
- `devices` counts Simlock's own devices of this platform and version that
  have not been deleted. Simlock does not track which variant a device uses,
  so two variants of one version show the same count.
- `foreignDevices` counts the devices outside Simlock that use the
  component: simulators in Xcode's default device set, or AVDs in your own
  AVD home (`ANDROID_AVD_HOME`, or `~/.android/avd`). Simlock only reads
  them.

A platform whose tools cannot answer is left out, and the other platform is
still listed. A gateway answers `UNSUPPORTED_IN_GATEWAY_MODE`; run the
command against the worker. A platform other than `ios` or `android`, or a
positional argument, is a usage error (exit 2).

## `simlock cleanup [--dry-run] [--rule <name>]`

Run the cleanup reconciliation immediately. `--dry-run` prints the actions
each rule *would* take (rule name, target, reason) without executing.
`--rule` restricts to a single named rule (e.g. `--rule idle-destroy`); see
`simlock list --rules` for the registered rules. A gateway owns no devices to
clean up, so it answers `UNSUPPORTED_IN_GATEWAY_MODE` (exit 2) — run this
against the worker whose machine you mean.

## `simlock doctor [--fix] [--purge-orphans] [--yes]`

Reconcile the daemon's state with reality (`simctl list`, `adb devices`,
running emulator processes): report orphaned processes, registry entries whose
device vanished, devices booted outside simlock, expired leases whose device is
still marked `leased`, devices stuck mid-transition, and orphans. `--fix`
applies the safe corrections. Reconciliation compares a registry against one
machine's driver reality, so a gateway — which has neither — answers
`UNSUPPORTED_IN_GATEWAY_MODE` (exit 2); run `doctor` on each worker.

An **orphan** is a device sitting inside a Simlock device root with no registry
record — almost always a daemon that died between creating a device and writing
it down. Because it is inside a root Simlock provably owns, it cannot be a
device of yours, so it is safe to destroy; but `--fix` never touches it.
Destroying orphans requires `--purge-orphans`, which asks for confirmation
unless `--yes` is given, and refuses (exit 2, `USAGE`) when confirmation is
declined or there is no terminal to ask at. Keeping it on its own flag means a
`doctor --fix` already running unattended in CI does not start deleting things
after an upgrade.

Before the first device of a purge is destroyed, each root the purge is about
to reach into is re-validated — ownership is proven at startup and then trusted
for the life of the daemon, which is fine for reporting and not fine for
destroying. A root that no longer
proves ownership abandons the whole purge and leaves every finding standing. So
does a device that could not be destroyed: it stays reported, and the rest of
the run continues.

Registry devices left behind in the *old* pre-device-root locations are
reported the same way and are destroyed by `--fix`, since they are in the
registry. They are not migrated: neither CoreSimulator nor the Android SDK
supports relocating a device, so those are re-provisioned.

A root that fails ownership validation at startup — missing or foreign marker,
symlink, wrong owner or permissions, or a `deviceRoot` that is not an absolute
path — stops that platform's driver and is reported here with the failing
reason. Driver discovery runs once, at daemon startup, so re-running `doctor`
after repairing the root reports the same finding until the daemon is
restarted; the finding says so.

Apart from its prerequisites (below), nothing else is reported about a
platform whose driver did not start. Its devices are unobservable, not missing, and `--fix` must never mark a registry
device deleted on the strength of a reality nobody could read.

A `provisioning` or `reclaiming` device is normally in-flight work Simlock
itself is driving and is not reported — but only up to a driver-derived
threshold (`Driver.estimate` for that operation, scaled by
`stalledTransition.thresholdMultiplier` and floored at
`stalledTransition.minimumThresholdMs`; see [CONFIGURATION.md](CONFIGURATION.md)).
Past that threshold it becomes a `stalled-transition` finding: the driver
call that was supposed to resolve the transition never did, and the
registry's view of the device has diverged from the driver's. `--fix`
responds the same way it does for a release-time purge failure — the device
enters `quarantined` (see [#21](https://github.com/callstackincubator/simlock/issues/21))
rather than being re-driven, since it may be mid-erase. As with every other
`--fix` correction, a leased device is never touched.

When `ios.defaultMode` is `slim`, `doctor` also reports a `driver-advisory`
finding (code `slim-runtime-unsupported`) for each installed iOS runtime
older than 18.5 — the version floor `launchctl disable` overrides need to
survive a reboot (see [CONFIGURATION.md](CONFIGURATION.md#device-mode-slim-and-full)).
A lease on those runtimes that asks for slim, or names no mode, gets a full
device; this finding is what makes that visible. It is advisory only — there
is no `--fix` for it, since the fix is upgrading the runtime.

On macOS, `doctor` also reports a `driver-advisory` finding (code
`runtime-cache-unreclaimable`) for each iOS runtime that was downloaded to
this machine and is no longer installed. Deleting a simulator runtime only
unregisters it: the download it was installed from — roughly 7-8 GiB of it
— stays in the operating system's own asset store, where it keeps spending
the same free space the download preflight measures, and where nothing
Simlock runs can reclaim it. On a host that has been leasing with downloads
enabled for a while, several of these can accumulate unnoticed. The finding
names each one and the one supported way to get the space back: remove the
platform in Xcode's Settings → Platforms. Advisory only, like the finding
above — reclaiming this space is outside anything `--fix` may do.

`doctor` also checks the [prerequisites](#prerequisites) of each platform
this host can run (iOS only on macOS), every time it runs. Each one missing is
a `prerequisite-missing` finding with `platform`, `prerequisite` (for example
`xcode`, `android-emulator` or `android-cmdline-tools`), `message`, and
`remedy` — the command or download page that installs it. With no Android SDK
at any searched path, that is a single `android-sdk` finding listing the
paths. Each finding is also printed to stderr as one line:

```text
Missing [android] android-emulator: The Android emulator package is not installed in /Users/me/Library/Android/sdk. Run `sdkmanager --install emulator`.
```

Installing a prerequisite clears its finding on the next `doctor` run. A
platform that is not running needs a daemon restart as well, and its
findings say so; once everything it needs is present, it gets one
`daemon-restart` finding until the daemon is restarted. A check that cannot
tell — a command that times out, say — reports nothing. These findings never
change the exit code, and `--fix` never installs anything.

## `simlock nuke [--delete-devices] [--yes]`

Emergency reset: force-release all leases, kill emulator/simulator processes
simlock started, clear the queue. With `--delete-devices`, also destroy every
registry-managed device. Never touches devices outside the registry. It stays
a per-machine command: a gateway answers `UNSUPPORTED_IN_GATEWAY_MODE` (exit
2), because a fleet-wide wipe from one endpoint is a footgun v1 does not
offer.

## `simlock events [--follow] [--since <duration>]`

Print business events (see [EVENTS.md](EVENTS.md)) as JSON lines.

- With no flags, prints the recent events the daemon holds in memory
  (`eventBuffer.capacity`, 1000 by default), which start empty after a
  restart.
- `--since 1h` reaches further back. Every event is also written to
  `~/.simlock/events.jsonl`, which survives restarts and crashes, so
  `--since` returns events from before the last restart and beyond the
  in-memory limit, back to the oldest event the file still holds. The file
  is capped by `eventLog.rotateBytes` (see
  [CONFIGURATION.md](CONFIGURATION.md)); the oldest events go first.
- `--since` without `--follow`, with no daemon running, reads the file
  directly and does not start a daemon. `--follow` starts one as usual.
- `--follow` keeps streaming live events. With `--since`, it prints that
  history first and then streams, with no event missing or printed twice
  where the two meet.

Against a **gateway** this is the fleet's stream: every connected worker's
business events, republished on the gateway's bus with `workerId` added to
the payload, interleaved with the gateway's own `worker.connected` /
`worker.disconnected` / `worker.rejected` / `worker.removed` /
`worker.drain-started` / `worker.drain-ended` / `request.dispatched` facts.
`worker.rejected` is how you find out why a machine never appeared in
`simlock worker list` at all — it reports an uplink refused at the door,
which nothing else records. The gateway writes these relayed events to its
own `events.jsonl` along with its own, so `--since` reaches back across a
gateway restart. It holds only what arrived while the gateway was up — a
worker's events from before its uplink connected are not backfilled.

## `simlock daemon <start|stop|status|logs [--follow]>`

Manage the daemon explicitly. Other commands auto-start it on demand; `daemon`
exists for operators and debugging. `start` starts whichever mode
`config.mode` selects — a worker (the default) or a gateway — and
`status` reports it, both in the human line (`Daemon: running (gateway)`) and
as `daemon.mode` under `--json`. `stop` does not touch leases: they persist,
and the next daemon restores each one's TTL timer from its deadline. What a
stop does end is the connections to it — a running `simlock lease` cannot
reconnect, so it exits `1` with a `DAEMON_CONNECTION_LOST` line naming a lease
that is still granted; renew it from a later invocation once the daemon is
back. A lease whose deadline passed while no daemon was running expires as soon
as one is. `logs` prints the last 100 lines of the daemon log and works even when
the daemon is dead — it reads the log file directly, no connection attempted.
`logs --follow` then keeps printing each new line as it is written, until you
press Ctrl-C (exit 0). It keeps following when the log rotates, and if no
daemon has written a log yet it waits for one. `--follow` cannot be combined
with `--json` (exit 2). `status` never
auto-starts the daemon and distinguishes two failure shapes:
`{"status":"stopped"}` when nothing is listening on the socket at all, versus
`{"status":"handshake-refused","error":{"code":...}}` (exit 1) when a daemon
answered but refused the connection (a bad admin credential, or a protocol
version mismatch) — the two used to be reported identically as "stopped".

A daemon that refuses to boot because of its configuration — a
`lease.defaultTtlMs` above `lease.maxTtlMs` or a non-positive value for
either, `mode: "gateway"` with `http.enabled: false`, or, in worker mode,
`gateway.url` without `gateway.token` or the reverse; see
[CONFIGURATION.md](CONFIGURATION.md) for the full set — fails the start
rather than picking a value the operator did not write. That validation runs
before the socket is claimed, so a command that auto-starts the daemon
(`simlock lease`, the MCP server) never gets a daemon to talk to: the launch
times out and the command fails with exit 1 (`INTERNAL`). The error line says nothing
about the config, because nothing ever answered — the reason is in `simlock
daemon logs`, which reads the log file directly and so works even though the
daemon never came up.

The daemon writes one JSON line per record to `~/.simlock/daemon.log`
(timestamp, level, module, message, and any fields). The log says what the
daemon was asked to do and what went wrong; what happened to leases and
devices is in `simlock events`, not here. It records:

- **Startup and shutdown**: version, protocol version, socket path, effective
  config, socket claim, driver discovery, and why a driver was skipped.
- **Every request that changes something**, on every frontend (CLI, MCP,
  HTTP, and a gateway's dispatch): one `operation` line when it finishes,
  with the operation, who asked (`principal`, and `requesterId` or `leaseId`
  when the request named one), how long it took, and the error code if it
  failed. A request that only reads is logged at `debug`, unless it fails.
- **Background failures** that Simlock handled by retrying, waiting, or
  destroying a device: the device, the lease when there is one, the step that
  failed, and the error text.
- **At `log.level: debug`**, every device command (`simctl`, `adb`,
  `sdkmanager`, …): the command, its arguments, its exit code, and how long it
  took. Never its environment, its input, or its output.
- Connection open and close, and errors nobody expected.

The wording and fields of a line can change in any release; don't parse them
as a contract. Growth is bounded: once the file passes `log.rotateBytes` it is
rotated to `daemon.log.1` (replacing any previous generation), so `logs` always
shows the current file with the immediately preceding one prepended.

## `simlock worker <list|drain|undrain|remove>`

The operator's view of a fleet. Every subcommand is an admin
operation **on a gateway**; against a worker they answer `UNKNOWN_REQUEST`
(exit 2), because a worker has no worker registry to answer from.

- `list [--json]` — one line per worker: its id (the worker's own instance
  identity — stable across restarts, and not its label or host name), its
  label if it set one, connection state, capacity, how many leases it
  holds, and its host: operating system, version, architecture, and tool
  versions. Under each worker, one indented line per component install
  waiting or running there, in the form `simlock status` prints. A worker the gateway cannot speak to shows `incompatible` with both
  protocol ranges, which is what version skew looks like from here. `--json`
  prints the raw worker views, which is what the console renders. Each
  view's catalog carries that worker's own `customModels`, so this is where
  you see which worker has a custom Android profile.
- `drain <worker-id>` / `undrain <worker-id>` — a drained worker keeps its
  existing leases and receives no new dispatches: the way to take a machine
  out of service without killing anyone's device. The flag is persisted by the
  gateway, so it survives both the worker's reconnect and a gateway restart —
  draining a machine and then rebooting it does not quietly put it back into
  rotation. Both are idempotent; an id the gateway has no view of is
  `UNKNOWN_WORKER` (exit 12).
- `remove <worker-id>` — forgets a **disconnected** worker's view. A connected
  one is refused with `WORKER_CONNECTED` (exit 2): it would announce itself
  again on its very next frame. An id with no view answers
  `{"removed":false}` rather than failing — forgetting something already
  forgotten is done, not an error. A view is also forgotten automatically once
  every lease on it has passed its deadline and
  `gateway.disconnectedRetentionMs` (default 24 h) has elapsed.

```console
$ simlock worker list
wrk_9f2c (mac-mini-1): connected -- ios 1/2, android 0/1, 1 lease(s) -- macOS 15.5 arm64; xcode 16.4 (16F6), emulator 35.4.9
  Install ios 26.4: downloading for 42s, 1 waiter
wrk_4a10 (ci-runner-3): disconnected, drained -- ios 0/4, android 0/2, 0 lease(s) -- macOS 14.7 x64; xcode 16.2 (16C5032a)
```

## `simlock config [get <key>|set <key> <value>]`

Show the effective configuration (defaults + config file + overrides): the
daemon's `mode`, managed and running capacity limits, idle tiers T1/T2/T3,
TTLs, disk-pressure threshold, and the daemon's log level/rotation cap
(`log.level`, `log.rotateBytes`). With no args, prints everything. The capacity numbers
come from the selected capacity strategy (`capacity.strategy`, configured
under `capacity.config` — see
[CONFIGURATION.md](CONFIGURATION.md#capacity-strategies)). Whichever strategy
is running, both a global and a per-platform running limit must have room
before Simlock provisions or boots a shutdown device.

`simlock config set mode gateway` turns this daemon into a **gateway** — one
that owns no devices and fronts the workers that join it — and `simlock
config set mode worker` turns it back. Like every `config set`, it is a
validated file write, and config is daemon *input*, read at start: the
running daemon keeps running in the mode it started in until
`simlock daemon stop` and the next start. The same command sets a worker's
`gateway.url` and `gateway.token` to join a fleet. See
[CONFIGURATION.md](CONFIGURATION.md#modes-gateway-and-worker) for which keys
each mode reads.

Switching to `gateway` is **two keys, not one**: `mode` and `http.enabled`.
A gateway is the fleet's contact point, so it must listen on HTTP — workers
open their uplinks there and remote agents lease through it — and
`mode: "gateway"` with `http.enabled: false` is therefore rejected at load
and the daemon does not start, naming the key. It is the one gateway config
pair that fails rather than warns, for the same reason a `lease.defaultTtlMs`
above `lease.maxTtlMs` fails: there is no safe way to read it. So:

```sh
simlock config set mode gateway
simlock config set http.enabled true
simlock daemon stop && simlock daemon start
```

## Admin credential resolution

Several commands (`list`, `cleanup`, `nuke`, `events`, `config get`,
`daemon stop`, `token create|list|revoke`,
`worker list|drain|undrain|remove`, and cross-process `lease renew`
and `release`) need the daemon's `admin` role. The CLI resolves a credential
to send at handshake, in order:

1. `--token <secret>` — accepted anywhere on the command line.
2. `SIMLOCK_ADMIN_TOKEN` — the environment variable.
3. the local `admin.token` file the daemon writes under `SIMLOCK_HOME` at
   startup (read is retried briefly, to ride out the daemon still writing it
   after a fresh `daemon start`).

When none of the three resolves (a different OS user, or the file genuinely
missing), the CLI connects as `agent` instead and writes a one-line stderr
notice; admin-only operations then fail with `FORBIDDEN` from the daemon,
same as any other role violation. `simlock lease`'s output JSON includes the
connection's resolved `role` so a caller can tell which one it got.

This is also why `simlock lease --detach` followed later by
`simlock lease renew <lease-id>` or `simlock release <lease-id>` from a
different invocation works even when each CLI process has a different
pid-derived identity: all of them connect as admin (when the local file is
readable), and admin bypasses the per-connection ownership check that would
otherwise apply.

## `simlock token create --role <agent|operator|worker> [--label <text>]` / `list` / `revoke <token-id>`

Mint and manage bearer tokens for the HTTP API. `token.create|list|revoke`
are daemon operations (admin role) — the daemon is the only process that
ever reads or writes `tokens.json`; the CLI is a thin client over the same
`simlock/admin` connection every other admin command uses.

Three roles:

- `agent` — the ordinary HTTP bearer token; one token is one requester.
- `operator` — everything an agent can do, plus the admin-only routes; also
  accepted as the admin credential at `hello` (see
  [admin credential resolution](#admin-credential-resolution)).
- `worker` — a **join token**: minted on a *gateway* and put in a
  worker's `gateway.token`. It authorizes exactly one thing, opening an uplink
  at `GET /v1/uplink`, and is `403` on every other `/v1` route; conversely an
  `agent` or `operator` token is `403` at `/v1/uplink`. Revoking one closes the
  uplink, and the worker keeps retrying at its backoff cap until an operator
  mints a replacement.

`create` prints the minted secret **once**, alongside the token record:

```json
{"token":{"id":"tok_9f2c","role":"agent","label":"ci-runner","createdAt":1735689600000},"secret":"slk_Wn9…"}
```

Only the secret's SHA-256 hash is ever persisted; there is no way to recover
a lost secret, only to `revoke` the token and `create` a new one. The token
id doubles as the requester identity over HTTP — one token is one requester,
same as the CLI's `--agent-id`.

`list` prints `{"tokens":[...]}` — the same record shape as `create`, minus
the secret and its hash. `revoke <token-id>` prints `{"revoked":true}` or
`{"revoked":false}` for an id that does not exist — the daemon's
`token.revoke` operation does not treat an unknown id as an error.

### The `worker` role: join tokens

`--role worker` mints a **join token**: the credential a worker presents when
it opens its uplink to a gateway. Mint it **on the gateway**,
then put the secret in that worker's `gateway.token` beside its
`gateway.url`. It is the narrowest role there is — a `worker` token can open
an uplink and nothing else, and presenting one on any `/v1` route other than
`/v1/uplink` is `403`, just as an `agent` or `operator` token presented at
`/v1/uplink` is. Tokens
do not cross machines either: a gateway's tokens are valid on that gateway
and nowhere else, and a worker's own tokens are its own.

`simlock token revoke <token-id>` on the gateway closes any uplink that token
opened, which is the way to eject a worker that should no longer be in the
fleet; `simlock worker remove` then forgets its view.

## Environment variables

### `SIMLOCK_HOME`

Overrides the data directory the CLI, MCP server, and daemon all use for
`config.json`, `state.json`, `daemon.sock`, `daemon.log`, `events.jsonl`, and — unless
overridden — the device roots themselves under `devices/`. Defaults to
`~/.simlock`. Because devices live under it, it needs a local volume with tens
of gigabytes free. All three frontends resolve it through the same function
(`resolveSimlockHome` in `src/ports/paths.ts`), so setting it once in an
agent's environment repoints every command at an isolated data directory —
useful for running multiple independent simlock instances on one machine, or
for tests. Two instances on one machine also need distinct
`drivers.android.adbServerPort` values, since a TCP port is machine-global and
`SIMLOCK_HOME` cannot isolate it. When the CLI or MCP server auto-starts the daemon, the daemon
process inherits the variable like the rest of the environment.

Keep it short: `daemon.sock` lives directly under it, and the kernel caps a Unix
socket path at 104 bytes on macOS (108 on Linux). A deeper `SIMLOCK_HOME` is
refused up front by every frontend with a `USAGE` error naming the limit, rather
than failing on connect with a bare `EINVAL`.

### `SIMLOCK_ADMIN_TOKEN`

The second source in [admin credential resolution](#admin-credential-resolution)
— an operator token (`simlock token create --role operator`) or the daemon's
per-start `admin.token` secret, either works. Set it once in a supervisor's
environment to avoid every admin command reading `admin.token` off disk.

### `SIMLOCK_DRIVERS_MODULE` (advanced / testing hook)

Overrides driver discovery (`discoverDrivers` in `src/daemon/main.ts`) with a
JavaScript module of your own instead of the real iOS/Android drivers. Point
it at a file path; the daemon dynamically imports that module and calls its
exported `createDrivers(context)` (the same `{ clock, driversConfig,
filesystem, hostPlatform, idGenerator, instanceId, logger, processRunner,
simlockHome }` context real discovery receives),
which must return `Driver[]` (or a promise of it, matching
`src/core/driver.ts`). This exists so tests — and anyone reproducing a bug
without real hardware — can run the full daemon against a scripted driver
instead of `simctl`/`adb`. It is not meant for production use: a module that
fails to import, or does not export `createDrivers`, fails daemon startup
loudly rather than silently falling back to real discovery. The module may
also export `prerequisiteChecks`, an array of `{ platform, check() }` objects
whose `check()` resolves to the `{ prerequisite, message, remedy }` entries
missing; `doctor` runs those in place of the real
[prerequisite](#prerequisites) checks, and runs none when the export is absent.

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

## Global exit codes

| Exit | Error code | Meaning |
|---|---|---|
| 0 | — | success (for a `lease` that stayed alive: the lease ended normally) |
| 1 | `INTERNAL` | internal / unexpected error |
| 2 | `USAGE` | usage error (bad flags, missing required args, unknown command) |
| 2 | `BAD_FRAME` | malformed request frame sent to the daemon |
| 2 | `BAD_REQUEST` | request payload failed validation |
| 10 | `QUEUE_TIMEOUT` | timed out waiting for a device (`--timeout` elapsed) |
| 11 | `NO_CAPACITY` | capacity reached and `--no-wait` was set |
| 12 | `NO_DRIVER` | no driver registered for the requested platform |
| 12 | `RUNTIME_MISSING` | runtime not installed and no `--allow-download` |
| 12 | `UNKNOWN_MODEL` | unknown device model for the platform |
| 12 | `INSUFFICIENT_DISK_SPACE` | not enough free disk space to install a component |
| 12 | `LICENSE_NOT_ACCEPTED` | a required license (e.g. an Android SDK license) is not accepted |
| 13 | `REQUESTER_ALREADY_LEASED` | requester already holds a lease or has a pending request — one lease per agent in v1; release the named lease first |
| 14 | — | `lease` without `--detach` only: the daemon ended the lease without the holder asking (TTL expiry, operator `release`, or an unrecoverable device) |

Every row but 14 matches the `cliExitCode` column of the contract's error
table (`src/contract/errors.ts`'s `ERROR_TABLE`) exactly — the CLI does not
maintain a second mapping; 14 is not a daemon error code but an outcome of a
`lease` that stays alive, so it lives beside the table's other `lease`
outcome, 0.
A daemon error code with no entry here (for example `UNKNOWN_LEASE`,
surfaced by `lease renew`) falls back to exit 1; the structured stderr line
still reports the specific code.

---

## Agent identity

Leases are keyed by requester: at most one active lease per agent id,
enforced by the daemon. Give each agent session a **stable**
id so this actually constrains anything — a fresh id on every CLI invocation
(the default) makes the constraint a no-op, since every invocation looks
like a different requester.

Resolution order, first match wins:

1. `--agent-id <id>` on `simlock lease`.
2. the `SIMLOCK_AGENT_ID` environment variable.
3. a pid-derived value (today's behavior; not stable across invocations).

Reuse the same id across an agent's own invocations (e.g. export
`SIMLOCK_AGENT_ID` once per agent session) and use a distinct id per agent so
they don't collide with each other. The id shows up as the requester in
`simlock status` and `simlock list --leases`, so an operator can tell which
agent holds what.

## `simlock lease`

Acquire a device. Blocks while waiting for capacity, then while provisioning
and booting, then — unless `--detach` — keeps running, renewing the lease on
a timer and releasing it when it exits.

```
simlock lease --platform <ios|android> --device <model> [--os <version>]
              [--agent-id <id>] [--timeout <duration>] [--no-wait] [--detach]
              [--ttl <duration>] [--allow-download] [--full] [--export-env]
              [--bind-pid <pid>]
```

There is only one kind of lease ([ADR
0004](adr/0004-ttl-first-leases-on-every-transport.md)): every lease has a
TTL and lives until it expires, is renewed, or is released. `--detach`
changes what *this process* does after the grant, not what the daemon
granted.

- `--platform`, `--device` — required. `--os` defaults to the newest runtime
  already installed for that platform.
- `--agent-id` — this invocation's requester identity; see
  [Agent identity](#agent-identity). Defaults to `SIMLOCK_AGENT_ID`, then a
  pid-derived value.
- `--timeout` — max time to wait in the queue (exit 10 on expiry).
- `--no-wait` — fail immediately with exit 11 instead of queueing.
- `--allow-download` — permit downloading a missing runtime / system image
  (multi-GB; never implicit). Without it, a missing runtime is exit 12.
  iOS runtimes remain Xcode-managed in v1: `--allow-download` cannot install
  them; install the runtime through Xcode first.
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
  automatically and the install retried once. Both drivers check free disk
  space before starting either install and fail fast, naming required vs.
  available bytes, instead of risking a full disk mid-download. Every
  install attempt (including a license-triggered retry) emits
  `component.install-started` / `component.installed` /
  `component.install-failed` on the event bus (`simlock events --follow`);
  see [EVENTS.md](EVENTS.md#components). The requester's own progress stream
  (below) does not yet reflect an in-flight download — see
  [known-pitfalls.md](known-pitfalls.md).
- `--full` — opt this lease out of iOS slim mode (see
  [CONFIGURATION.md](CONFIGURATION.md) for what slim mode disables). Only
  meaningful when `ios.slim.enabled` is on; ignored otherwise, and ignored
  for Android. A `--full` request never matches, and never shares a pool key
  with, a slim device, so it can wait for a fresh device to provision or
  force a re-provision of one already running, even while slim devices sit
  idle in the warm pool.
- `--detach` — print the lease result (the same JSON shape as the grant line
  below, including `device.featureProfile`) and exit instead of staying
  alive. Nothing then renews the lease on your behalf: keep it with
  `simlock lease renew` before `ttlDeadline`, and end it with
  `simlock release`.
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
resolved `role` (ADR 0003 §5):

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
{"device":{"id":"dev_1a2b","driverDeviceId":"ABCD-...","spec":{"platform":"ios","model":"iPhone 17 Pro","osVersion":"26.5"},"address":"...","featureProfile":"reduced"},"lease":{"id":"lse_9f2c","deviceId":"dev_1a2b","requesterId":"agent-1","ownerId":"agent-1","grantedAt":1735689600000,"ttlDeadline":1735690500000},"timing":{"estimatedProvisionMs":0,"estimatedBootMs":0,"estimatedReclaimMs":0,"estimatedReadyMs":0},"role":"agent"}
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
shorter `--ttl`; see
[known-pitfalls.md](known-pitfalls.md#a-sigkilled-lease-holder-keeps-its-device-until-the-ttl-expires).

**If the connection dies, the lease outlives it but this process does not.**
The CLI never reconnects (ADR 0003 §10), so a daemon that stops, crashes, or
has its socket killed leaves the holder unable to renew or release. It writes
one error line naming the lease and its deadline, and exits `1`:

```json
{"error":{"code":"DAEMON_CONNECTION_LOST","message":"lost the daemon connection; lease lse_9f2c is still yours until its ttlDeadline 1735690500000 — renew it with `simlock lease renew lse_9f2c` or let it expire"}}
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
`driverDeviceId`, `spec`, `address?`, `featureProfile?` — not the full
record `status.get`/`list.get` return to an admin caller. Internal
bookkeeping fields (`driverData`, `quarantine*`, `foreign*`, `recovering*`,
the derived `transitionAgeMs`) never appear on a grant; a caller that wants
those needs the admin-role `list.get`/`status.get`, not `lease.request`'s
output. `device.featureProfile` is `"reduced"` when the granted device had
its feature set reduced (iOS slim mode applied and this request did not pass
`--full`), and `"full"` or absent otherwise — always absent for Android. It
lets an agent explain a feature-loss failure (missing push notification,
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
{"push":"progress","stage":"provisioning","etaMs":90000}
{"push":"progress","stage":"booting","etaMs":60000}
{"push":"progress","stage":"reclaiming","etaMs":34000}
```

`push` is the one field the CLI adds to identify the line's kind; everything
else is the contract's `LeaseProgress` push, serialized as-is (ADR 0003 §11).

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
here, but equally `expired` or `killed`. See [known-pitfalls.md](known-pitfalls.md)
for what a reboot cannot bring back — anything the agent had running inside
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

## `simlock simctl <args...>`

Run `xcrun simctl` against Simlock's iOS device set. Every argument is passed
through unchanged with `--set <deviceRoot>` inserted, so the command behaves
exactly as documented by Apple — it just resolves the UDIDs Simlock manages,
which a bare `simctl` cannot see.

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
- `runtime delete` — it deletes a runtime shared with Xcode, and Simlock will
  not download one back. Delete it through Xcode if that is what you mean.
- `--set` and `--profiles`, in any spelling — `simlock simctl` supplies the
  device set itself. A caller-supplied one would point simctl outside what
  Simlock manages, and (because their value is a separate argument) would let
  a refused verb read as an ordinary operand. Run `xcrun simctl` directly if
  you mean to leave Simlock's set.

## `simlock adb <args...>`

Run `adb` against Simlock's adb server. Arguments pass through unchanged with
`-P <adbServerPort>` inserted.

```bash
simlock adb shell input tap 100 200
simlock adb logcat -d
```

Refused, all exit 2 with `USAGE` and a message naming what to run instead.
Each is matched anywhere in the arguments, so `-s <serial> emu kill` and
`-P 1 kill-server` are caught too:

- `kill-server` — it would detach every leased emulator at once. (Simlock's
  server rejects `kill-server` outright in any case.)
- `emu kill`, `emu avd stop` — they stop a device Simlock believes is
  running, which reports as drift on the next reconcile.
- `emu avd snapshot delete` — it destroys the clean-boot snapshot Simlock
  restores from, turning every later reclaim of that device from a snapshot
  load into a full wipe.

Use `simlock release` (which reclaims the device for you) or `simlock cleanup`
instead.

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

## `simlock mcp`

Start Simlock's local stdio MCP server. It accepts no flags. Standard output is
reserved for MCP JSON-RPC; fatal diagnostics are written to stderr. The server
auto-starts the daemon when needed and exposes the focused `list_devices`,
`lease_simulator`, `release_simulator`, and `lease_status` tool surface for one
agent session. `lease_simulator` accepts the contract's optional `ttlMs` —
defaulting to `lease.defaultTtlMs` and `BAD_REQUEST` above `lease.maxTtlMs`,
the same rule every other frontend gets — and the session renews that lease on
a timer and releases it when the process ends, the same policy `simlock lease`
follows. If that session's lease ends elsewhere (expiry or a force-release),
the server relays it as an MCP logging notification. A `lease_simulator` call
that carries a `_meta.progressToken` gets queue/provisioning/boot progress
relayed as MCP `notifications/progress` for that request. See
[../README.md](../README.md#mcp-integration-optional) for details.

The requester identity for leases made through this server is
`SIMLOCK_AGENT_ID`, falling back to a pid-derived value — see
[Agent identity](#agent-identity). Set a distinct `SIMLOCK_AGENT_ID` per MCP
server process (one per agent session) so the one-lease-per-agent rule is
meaningful.

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
  `device.featureProfile`** (`"full" | "reduced" | undefined`, undefined
  meaning "not applicable" — always undefined for Android). A caller
  checking `result.slim === true` now silently never sees a feature-loss
  signal at all — `result.slim` is simply `undefined` on every response,
  which is falsy, not an error. Check `result.device.featureProfile ===
  "reduced"` instead.

Every other field keeps the contract's own camelCase names it already had
under the pre-0.3.0 hand-written schemas (`leaseId`, `deviceId`,
`allowDownload`, `requesterId`, ...); those did not change shape, only their
schema's source of truth.

## `simlock status`

Human and JSON status include derived warm counts globally and per platform.
`ready` devices contribute to those counts; `reclaiming` and `quarantined`
devices remain visible as busy running capacity and never contribute to warm
inventory. A `quarantined` device is one whose release-time purge failed, or
whose `provisioning`/`reclaiming` transition stalled past its driver-derived
threshold (see `simlock doctor` below): it stays visible in `status` and
`list --devices` with that state while `QuarantineCoordinator` retries it in
the background, and is never handed to a new requester.

A device currently `provisioning` or `reclaiming` carries a derived
`transitionAgeMs` — how long it has been in that state — visible in `status`
and `list --devices` well before it crosses the threshold that would make
`doctor` flag it as stalled.

Human-oriented overview: daemon health, managed capacity (used/limit per
platform), running and reserved capacity (globally and per platform), every
managed device with its state, current leases (who — the agent id, see [Agent
identity](#agent-identity) — since when, and when each was last renewed), and
queue depth. `--json` for the structured equivalent. `overLimit` is true when a
lowered limit cannot yet be met, for example because active leases consume all
running slots.

## `simlock list [--devices|--leases|--rules]`

Scriptable listings of managed devices, active leases, or registered cleanup
rules. Defaults to `--devices`. Each lease record's `requesterId` is the
agent id (see [Agent identity](#agent-identity)) that holds it.

## `simlock catalog [--platform <ios|android>] [--json]`

Lists what can actually be leased, so an agent can pick a valid `--device`
and `--os` without a failed round trip through `lease`. For each available
platform: the resolvable device models, the runtimes / system images already
installed, and which installed runtime is the default (the newest). A
platform whose SDK is missing (e.g. Android without `ANDROID_HOME` on a
non-macOS host, or iOS off macOS) is omitted rather than erroring the whole
command. `--platform` narrows to one platform. Read-only: this never
downloads a runtime or system image.

Human-oriented by default (platform/model/runtime lines); `--json` for the
structured equivalent:

```json
{"platforms":[{"platform":"ios","models":["iPhone 17 Pro","iPhone 16"],"runtimes":["18.4","26.5"],"defaultRuntime":"26.5"}]}
```

## `simlock cleanup [--dry-run] [--rule <name>]`

Run the cleanup reconciliation immediately. `--dry-run` prints the actions
each rule *would* take (rule name, target, reason) without executing.
`--rule` restricts to a single named rule (e.g. `--rule idle-destroy`); see
`simlock list --rules` for the registered rules.

## `simlock doctor [--fix] [--purge-orphans] [--yes]`

Reconcile the daemon's state with reality (`simctl list`, `adb devices`,
running emulator processes): report orphaned processes, registry entries whose
device vanished, devices booted outside simlock, expired leases whose device is
still marked `leased`, devices stuck mid-transition, and orphans. `--fix`
applies the safe corrections.

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
destroying (see [known-pitfalls.md](known-pitfalls.md)). A root that no longer
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

Nothing else is reported about a platform whose driver did not start. Its
devices are unobservable, not missing, and `--fix` must never mark a registry
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

When `ios.slim.enabled` is on, `doctor` also reports a `driver-advisory`
finding (code `slim-runtime-unsupported`) for each installed iOS runtime
older than 18.5 — the version floor `launchctl disable` overrides need to
survive a reboot (see [CONFIGURATION.md](CONFIGURATION.md)). Slim mode
silently does nothing on those runtimes otherwise; this finding is what
makes that visible. It is advisory only — there is no `--fix` for it, since
the fix is either upgrading the runtime or narrowing `ios.slim` to the
runtimes that support it.

## `simlock nuke [--delete-devices] [--yes]`

Emergency reset: force-release all leases, kill emulator/simulator processes
simlock started, clear the queue. With `--delete-devices`, also destroy every
registry-managed device. Never touches devices outside the registry.

## `simlock events [--follow] [--since <duration>]`

Stream the business-event ring buffer (see [EVENTS.md](EVENTS.md)) as JSON
lines. `--follow` keeps streaming; `--since 1h` replays recent history.

## `simlock daemon <start|stop|status|logs>`

Manage the daemon explicitly. Other commands auto-start it on demand; `daemon`
exists for operators and debugging. `stop` does not touch leases: they persist,
and the next daemon restores each one's TTL timer from its deadline. What a
stop does end is the connections to it — a running `simlock lease` cannot
reconnect, so it exits `1` with a `DAEMON_CONNECTION_LOST` line naming a lease
that is still granted; renew it from a later invocation once the daemon is
back. A lease whose deadline passed while no daemon was running expires as soon
as one is. `logs` tails daemon logs and works even when the daemon is dead — it
reads the log file directly, no connection attempted. `status` never
auto-starts the daemon and distinguishes two failure shapes:
`{"status":"stopped"}` when nothing is listening on the socket at all, versus
`{"status":"handshake-refused","error":{"code":...}}` (exit 1) when a daemon
answered but refused the connection (a bad admin credential, or a protocol
version mismatch) — the two used to be reported identically as "stopped".

The daemon writes one structured JSON line per record to `~/.simlock/daemon.log`
(timestamp, level, module, message, and any fields) covering startup (version,
protocol version, socket path, effective config), socket claim/stale-endpoint
recovery, driver discovery, connection open/close, shutdown, and unexpected or
handled errors. Growth is bounded: once the file passes `log.rotateBytes` it is
rotated to `daemon.log.1` (replacing any previous generation), so `logs` always
shows the current file with the immediately preceding one prepended.

## `simlock config [get <key>|set <key> <value>]`

Show the effective configuration (defaults + config file + overrides):
managed and running capacity limits, idle tiers T1/T2/T3, TTLs, disk-pressure
threshold, and the daemon's log level/rotation cap (`log.level`,
`log.rotateBytes`). With no args, prints everything. The capacity numbers
come from the selected capacity strategy (`capacity.strategy`, configured
under `capacity.config` — see
[CONFIGURATION.md](CONFIGURATION.md#capacity-strategies)). Whichever strategy
is running, both a global and a per-platform running limit must have room
before Simlock provisions or boots a shutdown device.

## Admin credential resolution

Several commands (`list`, `cleanup`, `nuke`, `events`, `config get`,
`daemon stop`, `token create|list|revoke`, and cross-process `release`) need
the daemon's `admin` role. The CLI resolves a credential to send at
handshake, in order:

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
`simlock release <lease-id>` from a different invocation works even though
each CLI process has a different pid-derived identity: both commands connect
as admin (when the local file is readable), and admin bypasses the
per-connection ownership check that would otherwise apply.

## `simlock token create --role <agent|operator> [--label <text>]` / `list` / `revoke <token-id>`

Mint and manage bearer tokens for the HTTP API. `token.create|list|revoke`
are daemon operations (admin role) — the daemon is the only process that
ever reads or writes `tokens.json`; the CLI is a thin client over the same
`simlock/admin` connection every other admin command uses.

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

## Environment variables

### `SIMLOCK_HOME`

Overrides the data directory the CLI, MCP server, and daemon all use for
`config.json`, `state.json`, `daemon.sock`, `daemon.log`, and — unless
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
loudly rather than silently falling back to real discovery.

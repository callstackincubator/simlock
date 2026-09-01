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
| 0 | — | success (for `lease` held mode: lease ended normally) |
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
| 14 | — | `lease` held mode only: the daemon ended the lease without the holder asking (TTL backstop, operator `release`, or an unrecoverable device) |

Every row but 14 matches `DAEMON_ERROR_EXIT_CODES` in `src/cli/index.ts` exactly; 14 is not a daemon error code but an outcome of held mode, so it lives beside the table's other `lease` outcome, 0.
A daemon error code with no entry here (for example `UNKNOWN_LEASE`,
surfaced by `lease renew`) falls back to exit 1; the structured stderr line
still reports the specific code.

---

## Agent identity

Leases are keyed by requester: at most one active lease (held or detached)
per agent id, enforced by the daemon. Give each agent session a **stable**
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
and booting, then — in held mode — keeps running to hold the lease.

```
simlock lease --platform <ios|android> --device <model> [--os <version>]
              [--agent-id <id>] [--timeout <duration>] [--no-wait] [--detach]
              [--allow-download] [--bind-pid <pid>]
```

- `--platform`, `--device` — required. `--os` defaults to the newest runtime
  already installed for that platform.
- `--agent-id` — this invocation's requester identity; see
  [Agent identity](#agent-identity). Defaults to `SIMLOCK_AGENT_ID`, then a
  pid-derived value.
- `--timeout` — max time to wait in the queue (exit 10 on expiry).
- `--no-wait` — fail immediately with exit 11 instead of queueing.
- `--allow-download` — permit downloading a missing runtime / system image
  (multi-GB; never implicit). Without it, a missing runtime is exit 12.
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
- `--detach` — detached mode: print the lease result and exit; the lease is
  TTL-bound and must be renewed with `simlock lease renew`.
- `--bind-pid <pid>` — held mode only: watch this pid for death instead of
  the CLI's actual parent. For a holder spawned from a short-lived subshell,
  the immediate parent can die (and get reaped) while the owning agent is
  still very much alive; point this at the agent's own pid instead.

One lease per requester in v1: leasing while you already hold a lease or
have a request queued fails with `REQUESTER_ALREADY_LEASED` (exit 13); the
error message names the existing lease id to release first.

**Held mode (default):** intended to be run in the background by the agent.
As soon as the device is ready, one JSON line is printed on stdout:

```json
{"lease":"lse_9f2c","platform":"ios","device":"iPhone 17 Pro","os":"26.5","udid":"ABCD-...","state":"leased"}
```

then the process stays alive holding the lease. **Kill the process to
release** — or let it die on its own: held mode watches its parent (the pid
captured at startup, or `--bind-pid`) and releases and exits on its own the
moment that parent is gone, so a crashed or killed agent's backgrounded
`lease` does not outlive it. Progress streams on stderr and reflects only the
action selected for that request. A queued request reports its position
without speculative work stages; reclaiming work is reported separately:

```json
{"event":"queued","queue_position":1}
{"event":"provisioning","eta_seconds":90}
{"event":"booting","eta_seconds":60}
{"event":"reclaiming","eta_seconds":34}
```

`reclaiming` follows `queued` when the device the request is waiting on is
being purged for its previous holder: the position alone would not say that
the wait is an iOS erase rather than a moment. Every `eta_seconds` comes from
the driver's own estimate for the work it selected, which for a reclaim means
the strategy that clean level uses -- an erase runs tens of seconds, a
snapshot restore a few.

Once granted, held mode also relays the health monitor's findings about the
leased device for as long as the connection holds it, on the same stderr
stream:

```json
{"event":"device_unhealthy","lease":"lse_9f2c","device_id":"dev_1a2b"}
{"event":"device_recovered","lease":"lse_9f2c","device_id":"dev_1a2b","attempts":1}
```

`device_unhealthy` means the device stopped running outside simlock and a
reboot is in progress under the same lease; `device_recovered` means that
reboot passed readiness. The lease itself is untouched by either — it is
still held and must still be released the normal way. Recovery can instead
give up (the device vanished, its provenance no longer checks out, or reboot
attempts ran out); giving up is not itself one of these lines — it ends the
lease, which surfaces as the same line any other lease loss does:

```json
{"event":"lease_lost","lease":"lse_9f2c","device_id":"dev_1a2b","reason":"device-lost"}
```

In all three lines `device_id` is the registry device id — the `id` column of
`simlock list --devices`, and the same identifier the event bus uses — not the
driver-level `udid` the grant returns on stdout. A `lease_lost` line is
terminal for held mode: there is no longer a lease to
hold, so the process writes that line and exits `14` rather than waiting for a
signal, and it does not try to release a lease the daemon has already taken
back. The `reason` is whatever ended it — `device-lost` here, but equally
`expired` or `killed`. See [known-pitfalls.md](known-pitfalls.md)
for what a reboot cannot bring back — anything the agent had running inside
the device (a launched app, `log stream`, an Appium/XCUITest session, a port
forward) is gone whether or not recovery succeeds.

### `simlock lease renew <lease-id> [--ttl <duration>]`

Extend a lease's TTL — works for both detached and held-mode leases. Renewal
always resets the deadline to now plus the TTL, regardless of how much time
was left.

Without `--ttl`, the new deadline uses the lease's own mode-aware default:
`lease.detachedTtlMs` (15m) for a detached lease, `lease.heldTtlBackstopMs`
(1h) for a held one — never the other mode's default. Exit 1 if the lease is
unknown or already expired (error code `UNKNOWN_LEASE`).

A holder that declares the `heartbeat` capability — both frontends' held
mode — slides its own deadline to now + `lease.heldTtlBackstopMs`
automatically on every heartbeat, so renewing such a lease to a deadline
further out than that does not stick — the next heartbeat pulls it back in.
Hand-renewal remains the only keep-alive for detached mode, which by design
never holds a connection to heartbeat over.

## `simlock release <lease-id> | --all`

Explicitly release a lease (primarily for detached mode or operator
intervention). `--all` force-releases every lease — confirmation required
unless `--yes`.

Release returns as soon as the lease is gone, not when the device is clean.
Giving up the lease is a registry commit; wiping the device behind it is a
driver operation that can run tens of seconds (an iOS `simctl erase`), and it
proceeds in the background once the command has already exited. The same holds
for a held lease released by its holder exiting, and for `release_simulator`
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

Start Simlock's local stdio MCP server. It accepts no flags. Standard output
is reserved for MCP JSON-RPC; fatal diagnostics are written to stderr. The
server auto-starts the daemon when needed and exposes the focused
`list_devices`, `lease_simulator`, `release_simulator`, and `lease_status`
tool surface for one agent session. If that session's held lease ends
elsewhere (expiry or a force-release), the server relays it as an MCP logging
notification. A `lease_simulator` call that carries a `_meta.progressToken`
gets queue/provisioning/boot progress relayed as MCP `notifications/progress`
for that request. See [../README.md](../README.md#mcp-integration-optional)
for details.

The requester identity for leases made through this server is
`SIMLOCK_AGENT_ID`, falling back to a pid-derived value — see
[Agent identity](#agent-identity). Set a distinct `SIMLOCK_AGENT_ID` per MCP
server process (one per agent session) so the one-lease-per-agent rule is
meaningful.

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
managed device with its state, current leases (who — the agent id, see
[Agent identity](#agent-identity) — since when), and queue depth. `--json`
for the structured equivalent. `overLimit` is true when a lowered limit
cannot yet be met, for example because active leases consume all running
slots.

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

## `simlock doctor [--fix]`

Reconcile the daemon's state with reality (`simctl list`, `adb devices`,
running emulator processes): report orphaned processes, registry entries
whose device vanished, devices booted outside simlock, expired-but-held
leases, and devices stuck mid-transition. `--fix` applies the safe
corrections.

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

## `simlock nuke [--delete-devices] [--yes]`

Emergency reset: force-release all leases, kill emulator/simulator processes
simlock started, clear the queue. With `--delete-devices`, also destroy every
registry-managed device. Never touches devices outside the registry.

## `simlock events [--follow] [--since <duration>]`

Stream the business-event ring buffer (see [EVENTS.md](EVENTS.md)) as JSON
lines. `--follow` keeps streaming; `--since 1h` replays recent history.

## `simlock daemon <start|stop|status|logs>`

Manage the daemon explicitly. Other commands auto-start it on demand;
`daemon` exists for operators and debugging. `logs` tails daemon logs.

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

## Environment variables

### `SIMLOCK_HOME`

Overrides the data directory the CLI, MCP server, and daemon all use for
`config.json`, `state.json`, `daemon.sock`, and `daemon.log`. Defaults to
`~/.simlock`. All three frontends resolve it through the same function
(`resolveSimlockHome` in `src/ports/paths.ts`), so setting it once in an
agent's environment repoints every command at an isolated data directory —
useful for running multiple independent simlock instances on one machine, or
for tests. When the CLI or MCP server auto-starts the daemon, the daemon
process inherits the variable like the rest of the environment.

### `SIMLOCK_DRIVERS_MODULE` (advanced / testing hook)

Overrides driver discovery (`discoverDrivers` in `src/daemon/main.ts`) with a
JavaScript module of your own instead of the real iOS/Android drivers. Point
it at a file path; the daemon dynamically imports that module and calls its
exported `createDrivers(context)` (the same `{ clock, filesystem,
idGenerator, logger, processRunner }` context real discovery receives),
which must return `Driver[]` (or a promise of it, matching
`src/core/driver.ts`). This exists so tests — and anyone reproducing a bug
without real hardware — can run the full daemon against a scripted driver
instead of `simctl`/`adb`. It is not meant for production use: a module that
fails to import, or does not export `createDrivers`, fails daemon startup
loudly rather than silently falling back to real discovery.

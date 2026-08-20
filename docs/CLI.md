# CLI reference

Part of the user manual: every command the pitlane CLI is expected to
implement. Results are JSON on **stdout**; progress/diagnostics are JSON
lines on **stderr** — this is the default output, not an opt-in, because
agents are the primary audience. `status`, `catalog`, and
`daemon <start|stop|status|logs>` are the exception: they default to a
human-oriented view for interactive/operator use and accept `--json` to
switch to the structured form. Every other command's output is already
unconditionally JSON, so passing `--json` to it is a usage error (exit 2)
rather than a silent no-op. `pitlane mcp` reserves stdout for MCP JSON-RPC
framing and accepts no flags at all.

On failure, every command writes one structured line to stderr:

```json
{"error":{"code":"NO_CAPACITY","message":"No device capacity is currently available"}}
```

`code` is the daemon's own error code where the failure came from the
daemon, or a stable CLI-level code otherwise: `USAGE` for bad flags/missing
arguments/unknown commands, `INTERNAL` for anything unexpected. An unknown
command or a missing required argument gets a `message` that ends with a
pointer to `pitlane --help`, so a human hitting one from a terminal isn't
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
| 13 | `REQUESTER_ALREADY_LEASED` | requester already holds a lease or has a pending request — one lease per agent in v1; release the named lease first |

This table matches `DAEMON_ERROR_EXIT_CODES` in `src/cli/index.ts` exactly.
A daemon error code with no entry here (for example `UNKNOWN_LEASE` or
`HELD_LEASE_RENEWAL`, both surfaced by `lease renew`) falls back to exit 1;
the structured stderr line still reports the specific code.

---

## Agent identity

Leases are keyed by requester: at most one active lease (held or detached)
per agent id, enforced by the daemon. Give each agent session a **stable**
id so this actually constrains anything — a fresh id on every CLI invocation
(the default) makes the constraint a no-op, since every invocation looks
like a different requester.

Resolution order, first match wins:

1. `--agent-id <id>` on `pitlane lease`.
2. the `PITLANE_AGENT_ID` environment variable.
3. a pid-derived value (today's behavior; not stable across invocations).

Reuse the same id across an agent's own invocations (e.g. export
`PITLANE_AGENT_ID` once per agent session) and use a distinct id per agent so
they don't collide with each other. The id shows up as the requester in
`pitlane status` and `pitlane list --leases`, so an operator can tell which
agent holds what.

## `pitlane lease`

Acquire a device. Blocks while waiting for capacity, then while provisioning
and booting, then — in held mode — keeps running to hold the lease.

```
pitlane lease --platform <ios|android> --device <model> [--os <version>]
              [--agent-id <id>] [--timeout <duration>] [--no-wait] [--detach]
              [--allow-download]
```

- `--platform`, `--device` — required. `--os` defaults to the newest runtime
  already installed for that platform.
- `--agent-id` — this invocation's requester identity; see
  [Agent identity](#agent-identity). Defaults to `PITLANE_AGENT_ID`, then a
  pid-derived value.
- `--timeout` — max time to wait in the queue (exit 10 on expiry).
- `--no-wait` — fail immediately with exit 11 instead of queueing.
- `--allow-download` — permit downloading a missing runtime / system image
  (multi-GB; never implicit). Without it, a missing runtime is exit 12.
  iOS runtimes remain Xcode-managed in v1: `--allow-download` cannot install
  them; install the runtime through Xcode first.
- `--detach` — detached mode: print the lease result and exit; the lease is
  TTL-bound and must be renewed with `pitlane lease renew`.

One lease per requester in v1: leasing while you already hold a lease or
have a request queued fails with `REQUESTER_ALREADY_LEASED` (exit 13); the
error message names the existing lease id to release first.

**Held mode (default):** intended to be run in the background by the agent.
As soon as the device is ready, one JSON line is printed on stdout:

```json
{"lease":"lse_9f2c","platform":"ios","device":"iPhone 17 Pro","os":"26.5","udid":"ABCD-...","state":"leased"}
```

then the process stays alive holding the lease. **Kill the process to
release.** Progress streams on stderr and reflects only the action selected
for that request. A queued request reports its position without speculative
work stages; reclaiming work is reported separately:

```json
{"event":"queued","queue_position":1}
{"event":"provisioning","eta_seconds":90}
{"event":"booting","eta_seconds":30}
{"event":"reclaiming","eta_seconds":15}
```

### `pitlane lease renew <lease-id> [--ttl <duration>]`

Detached mode only: extend the lease TTL. Exit 1 if the lease is unknown or
already expired (error code `UNKNOWN_LEASE`), or if it is a held-mode lease,
which cannot be renewed (error code `HELD_LEASE_RENEWAL`).

## `pitlane release <lease-id> | --all`

Explicitly release a lease (primarily for detached mode or operator
intervention). `--all` force-releases every lease — confirmation required
unless `--yes`.

## `pitlane mcp`

Start Pitlane's local stdio MCP server. It accepts no flags. Standard output
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
`PITLANE_AGENT_ID`, falling back to a pid-derived value — see
[Agent identity](#agent-identity). Set a distinct `PITLANE_AGENT_ID` per MCP
server process (one per agent session) so the one-lease-per-agent rule is
meaningful.

## `pitlane status`

Human and JSON status include derived warm counts globally and per platform.
`ready` devices contribute to those counts; `reclaiming` devices remain
visible as busy running capacity and never contribute to warm inventory.

Human-oriented overview: daemon health, managed capacity (used/limit per
platform), running and reserved capacity (globally and per platform), every
managed device with its state, current leases (who — the agent id, see
[Agent identity](#agent-identity) — since when), and queue depth. `--json`
for the structured equivalent. `overLimit` is true when a lowered limit
cannot yet be met, for example because active leases consume all running
slots.

## `pitlane list [--devices|--leases|--rules]`

Scriptable listings of managed devices, active leases, or registered cleanup
rules. Defaults to `--devices`. Each lease record's `requesterId` is the
agent id (see [Agent identity](#agent-identity)) that holds it.

## `pitlane catalog [--platform <ios|android>] [--json]`

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

## `pitlane cleanup [--dry-run] [--rule <name>]`

Run the cleanup reconciliation immediately. `--dry-run` prints the actions
each rule *would* take (rule name, target, reason) without executing.
`--rule` restricts to a single rule (e.g. the explicit runtime GC).

## `pitlane doctor [--fix]`

Reconcile the daemon's state with reality (`simctl list`, `adb devices`,
running emulator processes): report orphaned processes, registry entries
whose device vanished, devices booted outside pitlane, expired-but-held
leases. `--fix` applies the safe corrections.

## `pitlane nuke [--delete-devices] [--yes]`

Emergency reset: force-release all leases, kill emulator/simulator processes
pitlane started, clear the queue. With `--delete-devices`, also destroy every
registry-managed device. Never touches devices outside the registry.

## `pitlane events [--follow] [--since <duration>]`

Stream the business-event ring buffer (see [EVENTS.md](EVENTS.md)) as JSON
lines. `--follow` keeps streaming; `--since 1h` replays recent history.

## `pitlane daemon <start|stop|status|logs>`

Manage the daemon explicitly. Other commands auto-start it on demand;
`daemon` exists for operators and debugging. `logs` tails daemon logs.

The daemon writes one structured JSON line per record to `~/.pitlane/daemon.log`
(timestamp, level, module, message, and any fields) covering startup (version,
protocol version, socket path, effective config), socket claim/stale-endpoint
recovery, driver discovery, connection open/close, shutdown, and unexpected or
handled errors. Growth is bounded: once the file passes `log.rotateBytes` it is
rotated to `daemon.log.1` (replacing any previous generation), so `logs` always
shows the current file with the immediately preceding one prepended.

## `pitlane config [get <key>|set <key> <value>]`

Show the effective configuration (defaults + config file + overrides):
managed and running capacity limits, idle tiers T1/T2/T3, TTLs, disk-pressure
threshold, and the daemon's log level/rotation cap (`log.level`,
`log.rotateBytes`). With no args, prints everything. Running capacity
uses `limits.maxRunning` globally and `limits.<platform>.maxRunning` for each
driver; both must have room before provisioning or booting a shutdown device.

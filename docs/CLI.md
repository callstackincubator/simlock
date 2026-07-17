# CLI reference

Part of the user manual: every command the pitlane CLI is expected to
implement. All commands accept `--json` for machine-readable output (agents
are the primary audience). Progress/diagnostics go to **stderr** as JSON
lines; results go to **stdout**.

## Global exit codes

| Code | Meaning |
|---|---|
| 0 | success (for `lease` held mode: lease ended normally) |
| 1 | internal / unexpected error |
| 2 | usage error (bad flags, missing required args) |
| 10 | timed out waiting for a device (`--timeout` elapsed) |
| 11 | capacity reached and `--no-wait` was set |
| 12 | spec unresolvable (unknown model, or runtime not installed and no `--allow-download`) |

---

## `pitlane lease`

Acquire a device. Blocks while waiting for capacity, then while provisioning
and booting, then — in held mode — keeps running to hold the lease.

```
pitlane lease --platform <ios|android> --device <model> [--os <version>]
              [--timeout <duration>] [--no-wait] [--detach]
              [--allow-download] [--json]
```

- `--platform`, `--device` — required. `--os` defaults to the newest runtime
  already installed for that platform.
- `--timeout` — max time to wait in the queue (exit 10 on expiry).
- `--no-wait` — fail immediately with exit 11 instead of queueing.
- `--allow-download` — permit downloading a missing runtime / system image
  (multi-GB; never implicit). Without it, a missing runtime is exit 12.
  iOS runtimes remain Xcode-managed in v1: `--allow-download` cannot install
  them; install the runtime through Xcode first.
- `--detach` — detached mode: print the lease result and exit; the lease is
  TTL-bound and must be renewed with `pitlane lease renew`.

**Held mode (default):** intended to be run in the background by the agent.
As soon as the device is ready, one JSON line is printed on stdout:

```json
{"lease":"lse_9f2c","platform":"ios","device":"iPhone 17 Pro","os":"26.5","udid":"ABCD-...","state":"leased"}
```

then the process stays alive holding the lease. **Kill the process to
release.** Progress streams on stderr and reflects only the action selected
for that request. A queued request reports its position without speculative
work stages; reclaiming a warm device is reported separately:

```json
{"event":"queued","queue_position":1}
{"event":"provisioning","eta_seconds":90}
{"event":"booting","eta_seconds":30}
{"event":"reclaiming","eta_seconds":15}
```

### `pitlane lease renew <lease-id> [--ttl <duration>]`

Detached mode only: extend the lease TTL. Exit 1 if the lease is unknown or
already expired.

## `pitlane release <lease-id> | --all`

Explicitly release a lease (primarily for detached mode or operator
intervention). `--all` force-releases every lease — confirmation required
unless `--yes`.

## `pitlane status`

Human-oriented overview: daemon health, managed capacity (used/limit per
platform), running and reserved capacity (globally and per platform), every
managed device with its state, current leases (who, since when), and queue
depth. `--json` for the structured equivalent. `overLimit` is true when a
lowered limit cannot yet be met, for example because active leases consume
all running slots.

## `pitlane list [--devices|--leases|--rules]`

Scriptable listings of managed devices, active leases, or registered cleanup
rules. Defaults to `--devices`.

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

## `pitlane config [get <key>|set <key> <value>]`

Show the effective configuration (defaults + config file + overrides):
managed and running capacity limits, idle tiers T1/T2/T3, TTLs, disk-pressure
threshold, warm-pool sizes. With no args, prints everything. Running capacity
uses `limits.maxRunning` globally and `limits.<platform>.maxRunning` for each
driver; both must have room before provisioning or booting a shutdown device.

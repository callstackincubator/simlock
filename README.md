# Pitlane

Pitlane is a control plane for iOS simulators and Android emulators, built
for environments where multiple coding agents run in parallel on one
machine.

## The problem

Agents that need a simulator grab whatever `simctl` / `avdmanager` shows
them. Two agents that pick the same device start fighting over it —
booting, erasing, and installing over each other — without ever knowing the
other exists.

## The solution

Pitlane is a CLI-first control plane (backed by a local daemon) that works the
same way for both platforms and gives agents one primitive: **lease a device**.
Agents that support the Model Context Protocol (MCP) can optionally use the
same lease workflow through a local stdio server.

## Features

- **Lease, don't grab.** `pitlane lease` hands back a device — booted and
  health-checked — that no other agent will touch for the duration of the
  lease.
- **Auto-provisioning.** If no matching device is free, Pitlane provisions
  one, up to a capacity limit derived from the machine's CPU and RAM.
- **Fair queueing.** Once the limit is reached, requests block and wait in a
  fair queue until a device frees up, with `--timeout` and `--no-wait`
  escape hatches.
- **Tiered idle cleanup.** Devices that sit unused are shut down after a
  short idle period to reclaim RAM, then deleted after a longer one to
  reclaim disk.
- **Advisory coordination.** Pitlane doesn't sandbox anything — it works
  because agents are instructed to only use devices handed to them by a
  lease, never to call `simctl` / `avdmanager` directly.
- **Managed-device registry.** Pitlane only ever shuts down, erases, or
  deletes devices it created itself. Everything else on the machine is
  read-only to it.
- **Agent-first output.** CLI lease results are one JSON line on stdout;
  progress (e.g. provisioning ETAs) streams as JSON lines on stderr. The
  optional MCP server reserves stdout for MCP JSON-RPC.
- **Optional MCP integration.** A local stdio MCP server gives agent clients
  the lease and release workflow without replacing the CLI operator interface.

## Getting started

```sh
pnpm install
pnpm build
pitlane lease --platform ios --device "iPhone 16" --detach --json
pitlane status --json
```

The daemon starts on demand — no separate setup step is needed. Use
`pitlane doctor` to reconcile managed state with reality, and
`pitlane nuke --yes --delete-devices` only for an emergency reset of
Pitlane-managed devices.

See [docs/CLI.md](docs/CLI.md) for the full command reference.

## MCP integration (optional)

The CLI remains Pitlane's primary, full operator interface. MCP is a focused
agent integration: it intentionally exposes neither status, configuration,
events, lease renewal, nor destructive or other operator commands.

Start the local stdio server with:

```sh
pitlane mcp
```

Configure an MCP client to spawn it with this generic configuration:

```json
{
  "mcpServers": {
    "pitlane": {
      "command": "pitlane",
      "args": ["mcp"]
    }
  }
}
```

GUI-launched MCP clients may not inherit your shell `PATH`; in that case,
replace `pitlane` with its absolute path.

The server provides exactly three tools:

- `list_devices` returns, per available platform, the resolvable device
  models, the runtimes / system images already installed, and which
  installed runtime is the default (the newest). An optional `platform`
  (`ios` or `android`) narrows the result. It is read-only — it never
  downloads a runtime or system image — so call it once to pick a valid
  `device`/`os` before `lease_simulator` instead of guessing.
- `lease_simulator` requires `platform` (`ios` or `android`) and `device`.
  `os` is optional and otherwise selects the newest installed runtime.
  `no_wait` defaults to `false`; `timeout_seconds` optionally limits queue
  waiting. `allow_download` defaults to `false` and must be explicitly `true`
  before a missing runtime or system image may be downloaded.
- `release_simulator` requires the `lease_id` returned by the lease tool and
  releases only that MCP session's lease.

All three tools return structured results as well as JSON text content, so
MCP clients can reliably consume the device catalog, leased device details,
or release confirmation. An MCP lease is held by the server process's daemon
connection: release it explicitly when work is done; it is also released
when that MCP process disconnects. Run one MCP server process per agent
session.

## Configuration

Pitlane reads `~/.pitlane/config.json` and merges it over built-in
defaults. Only the keys below are recognized; unknown keys are ignored with
a warning. Inspect the effective, merged configuration at any time with
`pitlane config`.

| Property                          | Description                                                                              | Default                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `limits.maxRunning`               | Global cap on devices running at once, across both platforms.                            | Sum of `limits.ios.maxDevices` and `limits.android.maxDevices` |
| `limits.ios.maxDevices`           | Max number of iOS simulators Pitlane will manage at once.                                | `max(1, cpuCount / 2)`                                         |
| `limits.ios.maxRunning`           | Max number of iOS simulators running at once.                                            | Same as `limits.ios.maxDevices`                                |
| `limits.android.maxDevices`       | Max number of Android emulators Pitlane will manage at once.                             | `max(1, min(cpuCount / 4, totalRamGb / 8))`                    |
| `limits.android.maxRunning`       | Max number of Android emulators running at once.                                         | Same as `limits.android.maxDevices`                            |
| `ramBudget.iosBytesPerDevice`     | RAM reserved per iOS simulator when computing capacity.                                  | `1.5 GiB`                                                      |
| `ramBudget.androidBytesPerDevice` | RAM reserved per Android emulator when computing capacity.                               | `4 GiB`                                                        |
| `idle.shutdownAfterMs`            | How long an unused device sits idle before Pitlane shuts it down (tier 1, reclaims RAM). | `10 minutes`                                                   |
| `idle.deleteAfterMs`              | How long a shut-down device sits idle before Pitlane deletes it (tier 2, reclaims disk). | `1 hour`                                                       |
| `lease.heldTtlBackstopMs`         | Backstop TTL for held-mode leases, in case the holding process dies without releasing.   | `1 hour`                                                       |
| `lease.detachedTtlMs`             | TTL for detached-mode leases before they must be renewed with `pitlane lease renew`.     | `15 minutes`                                                   |
| `diskPressure.freeBytesThreshold` | Free disk space below which Pitlane treats the machine as under disk pressure.           | `10 GiB`                                                       |
| `eventBuffer.capacity`            | Number of business events kept in the in-memory ring buffer (see `pitlane events`).      | `1000`                                                         |

All limit values must be positive integers; all durations and byte sizes
must be non-negative numbers (milliseconds and bytes, respectively).
Running limits are independent of managed-device limits — an omitted
`maxRunning` defaults to its corresponding `maxDevices` value (and, at the
global level, to their sum):

```json
{
  "limits": {
    "maxRunning": 3,
    "ios": { "maxDevices": 4, "maxRunning": 2 },
    "android": { "maxDevices": 2, "maxRunning": 2 }
  }
}
```

# Configuration

Simlock reads `~/.simlock/config.json` and merges it over built-in
defaults. Only the keys below are recognized; unknown keys are ignored with
a warning. Inspect the effective, merged configuration at any time with
`simlock config`.

| Property                          | Description                                                                                                                                                                                                                  | Default                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `capacity.strategy`               | Which policy decides how many devices may exist and run at once: `resource` or `fixed`. The options under `capacity.config` are that strategy's own -- see [Capacity strategies](#capacity-strategies).                     | `resource`                                                      |
| `idle.shutdownAfterMs`            | How long an unused device sits idle before Simlock shuts it down (tier 1, reclaims RAM).                                                                                                                                     | `10 minutes`                                                    |
| `idle.deleteAfterMs`              | How long a shut-down device sits idle before Simlock deletes it (tier 2, reclaims disk).                                                                                                                                     | `1 hour`                                                        |
| `warmPool.quarantine.maxRetries`  | Failed purge retries allowed on a quarantined device (after the triggering failure) before Simlock gives up and destroys it.                                                                                                | `3`                                                              |
| `warmPool.quarantine.retryBackoffMs` | Delay before the first quarantine purge retry.                                                                                                                                                                            | `30 seconds`                                                     |
| `warmPool.quarantine.retryBackoffMultiplier` | Growth factor applied to the backoff after each failed retry.                                                                                                                                                     | `2`                                                               |
| `warmPool.quarantine.maxRetryBackoffMs` | Cap on the quarantine retry backoff.                                                                                                                                                                                   | `5 minutes`                                                      |
| `lease.heldTtlBackstopMs`         | Backstop TTL for held-mode leases, in case the holding process dies without releasing.                                                                                                                                       | `1 hour`                                                        |
| `lease.detachedTtlMs`             | TTL for detached-mode leases before they must be renewed with `simlock lease renew`.                                                                                                                                         | `15 minutes`                                                    |
| `lease.heartbeatIntervalMs`       | How often the daemon pings a held-mode connection that declared the `heartbeat` capability; each pong slides that connection's leases' TTL back out to a full `heldTtlBackstopMs`. Must be `<= lease.heldTtlBackstopMs / 4`. | `5 minutes`                                                     |
| `http.enabled`                    | Master switch for the network-facing HTTP API (see [HTTP-API.md](HTTP-API.md)). Off by default; the daemon binds nothing until this is `true`.                                                                              | `false`                                                          |
| `http.host`                       | Address the HTTP listener binds. `127.0.0.1` keeps it loopback-only; reaching it remotely is the operator's own tunnel (Tailscale, cloudflared, reverse proxy) — Simlock does no TLS termination in v1.                     | `127.0.0.1`                                                      |
| `http.port`                       | Port the HTTP listener binds. Must be an integer `1`-`65535`.                                                                                                                                                                 | `4700`                                                           |
| `diskPressure.freeBytesThreshold` | Free disk space below which Simlock treats the machine as under disk pressure.                                                                                                                                               | `10 GiB`                                                         |
| `eventBuffer.capacity`            | Number of business events kept in the in-memory ring buffer (see `simlock events`).                                                                                                                                          | `1000`                                                           |
| `health.enabled`                  | Master switch for leased-device crash detection and recovery.                                                                                                                                                                | `true`                                                           |
| `health.probeIntervalMs`          | How often the health monitor observes leased devices against driver reality.                                                                                                                                                | `30 seconds`                                                     |
| `health.stableObservations`       | Consecutive `stopped` observations required before a leased device is treated as crashed; guards against transient `Booting`/`Shutting Down`/adb-offline readings.                                                         | `2`                                                               |
| `health.maxRecoveryAttempts`      | Reboot attempts for one lease before the lease is given up as lost.                                                                                                                                                          | `3`                                                               |
| `health.recoveryBackoffMs`        | Base delay between reboot attempts; the monitor applies exponential backoff over it.                                                                                                                                        | `5 seconds`                                                      |
| `health.maxConcurrentRecoveries`  | Cap on simultaneous recovery reboots, so a machine wake (every device reads `stopped` at once) cannot start a boot storm.                                                                                                   | `1`                                                               |
| `stalledTransition.thresholdMultiplier` | Factor applied to a driver's own `provision + boot` (for `provisioning`) or `reclaim` (for `reclaiming`) estimate to get the stall threshold for `simlock doctor`'s `stalled-transition` finding. | `3`                                                               |
| `stalledTransition.minimumThresholdMs` | Floor under the multiplied estimate, for a driver whose estimate is near zero.                                                                                                                                | `1 minute`                                                        |
| `ios.slim.enabled`                | Master switch for slim mode: disables iOS simulator daemon categories to cut RAM and CPU overhead per device.                                                                                                                | `false`                                                          |
| `ios.slim.categories`             | Which daemon categories to disable when slim mode is on. Omitted means every category the driver knows.                                                                                                                      | every known category                                             |
| `ios.slim.bootTimeoutMs`          | Boot deadline used while slim mode is on, in place of the normal boot timeout.                                                                                                                                                | `10 minutes`                                                     |

All limit values must be positive integers; all durations and byte sizes
must be non-negative numbers (milliseconds and bytes, respectively).
`health.enabled` is a boolean; `health.probeIntervalMs` and
`health.recoveryBackoffMs` must be positive numbers; and
`health.stableObservations`, `health.maxRecoveryAttempts`, and
`health.maxConcurrentRecoveries` must be positive integers.
`stalledTransition.thresholdMultiplier` must be a number `>= 1`;
`stalledTransition.minimumThresholdMs` must be a non-negative number.
`http.enabled` is a boolean, `http.host` a string, and `http.port` an
integer in `1`-`65535`.
`ios.slim.enabled` is a boolean, `ios.slim.categories` an array of
non-empty strings, and `ios.slim.bootTimeoutMs` a positive number.
See [CLI.md](CLI.md#simlock-config-get-keyset-key-value) for the
`simlock config` command itself.

Slim mode is opt-in and iOS-only: it disables simulator daemon categories
(e.g. logging, diagnostics) that most agent workloads never touch, trading
some simulator functionality for a leaner runtime footprint. It requires
iOS 18.5 or newer, since the underlying daemon controls are not available
on older runtimes. Turning it on costs an extra boot per device -- the
daemons are disabled between a first boot and a second, slower one -- which
is why `ios.slim.bootTimeoutMs` defaults higher than the normal boot
timeout, especially on slower CI runners.

## Capacity strategies

How many devices Simlock lets exist and run at once is decided by a capacity
strategy. `capacity.strategy` picks one; `capacity.config` holds that
strategy's own options, so its shape depends on the strategy you selected.

### `resource` (default)

Device and running ceilings derived from the machine, with a RAM budget on
top: a device is only created if its budgeted RAM still fits under the
machine's total, minus 4 GiB left for the OS.

| Property                                        | Description                                                     | Default                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `capacity.config.limits.maxRunning`             | Global cap on devices running at once, across both platforms.   | Sum of the two `maxDevices` values                                          |
| `capacity.config.limits.ios.maxDevices`         | Max iOS simulators Simlock will manage at once.                 | `max(1, cpuCount / 2)`                                                      |
| `capacity.config.limits.ios.maxRunning`         | Max iOS simulators running at once.                             | Same as `capacity.config.limits.ios.maxDevices`                             |
| `capacity.config.limits.android.maxDevices`     | Max Android emulators Simlock will manage at once.              | `max(1, min(cpuCount / 4, totalRamGb / 8))`                                 |
| `capacity.config.limits.android.maxRunning`     | Max Android emulators running at once.                          | Same as `capacity.config.limits.android.maxDevices`                         |
| `capacity.config.ramBudget.iosBytesPerDevice`   | RAM reserved per iOS simulator when computing capacity.         | `1.5 GiB`                                                                    |
| `capacity.config.ramBudget.androidBytesPerDevice` | RAM reserved per Android emulator when computing capacity.    | `4 GiB`                                                                      |

Running limits are independent of managed-device limits — an omitted
`maxRunning` defaults to its corresponding `maxDevices` value (and, at the
global level, to their sum):

```json
{
  "capacity": {
    "strategy": "resource",
    "config": {
      "limits": {
        "maxRunning": 3,
        "ios": { "maxDevices": 4, "maxRunning": 2 },
        "android": { "maxDevices": 2, "maxRunning": 2 }
      }
    }
  }
}
```

### `fixed`

A pinned number of devices, with no machine inspection at all: no RAM
budget, and no CPU- or RAM-derived defaults. Use it when you want the
concurrency to be exactly the number you wrote down, on every machine.

| Property                              | Description                                                | Default                                    |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| `capacity.config.maxRunning`          | Devices running at once, across both platforms.            | `2`                                        |
| `capacity.config.ios.maxRunning`      | iOS simulators running at once.                            | `capacity.config.maxRunning`               |
| `capacity.config.ios.maxDevices`      | iOS simulators Simlock will manage at once.                | `capacity.config.ios.maxRunning`           |
| `capacity.config.android.maxRunning`  | Android emulators running at once.                         | `capacity.config.maxRunning`               |
| `capacity.config.android.maxDevices`  | Android emulators Simlock will manage at once.             | `capacity.config.android.maxRunning`       |

`maxRunning` on its own is a complete configuration — the per-platform
blocks exist only to carve that budget up:

```json
{
  "capacity": { "strategy": "fixed", "config": { "maxRunning": 4 } }
}
```

### Older config files

Before capacity strategies existed, the `resource` options were spelled as
top-level `limits` and `ramBudget` keys. Those still work exactly as they
did — a config file written against an older Simlock keeps its behaviour
without changes, and needs none. Setting them alongside an explicitly
selected non-`resource` strategy is the one case Simlock warns about, since
those settings would have no effect.

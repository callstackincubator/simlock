# Configuration

Pitlane reads `~/.pitlane/config.json` and merges it over built-in
defaults. Only the keys below are recognized; unknown keys are ignored with
a warning. Inspect the effective, merged configuration at any time with
`pitlane config`.

| Property                          | Description                                                                                                                                                                                                                  | Default                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `limits.maxRunning`               | Global cap on devices running at once, across both platforms.                                                                                                                                                                | Sum of `limits.ios.maxDevices` and `limits.android.maxDevices` |
| `limits.ios.maxDevices`           | Max number of iOS simulators Pitlane will manage at once.                                                                                                                                                                    | `max(1, cpuCount / 2)`                                         |
| `limits.ios.maxRunning`           | Max number of iOS simulators running at once.                                                                                                                                                                                | Same as `limits.ios.maxDevices`                                |
| `limits.android.maxDevices`       | Max number of Android emulators Pitlane will manage at once.                                                                                                                                                                 | `max(1, min(cpuCount / 4, totalRamGb / 8))`                    |
| `limits.android.maxRunning`       | Max number of Android emulators running at once.                                                                                                                                                                             | Same as `limits.android.maxDevices`                            |
| `ramBudget.iosBytesPerDevice`     | RAM reserved per iOS simulator when computing capacity.                                                                                                                                                                      | `1.5 GiB`                                                       |
| `ramBudget.androidBytesPerDevice` | RAM reserved per Android emulator when computing capacity.                                                                                                                                                                   | `4 GiB`                                                         |
| `idle.shutdownAfterMs`            | How long an unused device sits idle before Pitlane shuts it down (tier 1, reclaims RAM).                                                                                                                                     | `10 minutes`                                                    |
| `idle.deleteAfterMs`              | How long a shut-down device sits idle before Pitlane deletes it (tier 2, reclaims disk).                                                                                                                                     | `1 hour`                                                        |
| `lease.heldTtlBackstopMs`         | Backstop TTL for held-mode leases, in case the holding process dies without releasing.                                                                                                                                       | `1 hour`                                                        |
| `lease.detachedTtlMs`             | TTL for detached-mode leases before they must be renewed with `pitlane lease renew`.                                                                                                                                         | `15 minutes`                                                    |
| `lease.heartbeatIntervalMs`       | How often the daemon pings a held-mode connection that declared the `heartbeat` capability; each pong slides that connection's leases' TTL back out to a full `heldTtlBackstopMs`. Must be `<= lease.heldTtlBackstopMs / 4`. | `5 minutes`                                                     |
| `diskPressure.freeBytesThreshold` | Free disk space below which Pitlane treats the machine as under disk pressure.                                                                                                                                               | `10 GiB`                                                         |
| `eventBuffer.capacity`            | Number of business events kept in the in-memory ring buffer (see `pitlane events`).                                                                                                                                          | `1000`                                                           |

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

See [CLI.md](CLI.md#pitlane-config-get-keyset-key-value) for the
`pitlane config` command itself.

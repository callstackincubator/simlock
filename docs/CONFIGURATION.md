# Configuration

Simlock reads `~/.simlock/config.json` and merges it over built-in
defaults. Only the keys below are recognized; unknown keys are ignored with
a warning. Inspect the effective, merged configuration at any time with
`simlock config`.

| Property                          | Description                                                                                                                                                                                                                  | Default                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `mode`                            | Which shape this daemon runs as: `worker` (owns the devices on this machine) or `gateway` (owns none, fronts the workers that join it -- see [ADR 0005](adr/0005-gateway-and-worker-modes.md)). One daemon runs exactly one mode. Only `worker` does anything in this release; the value is reported on `simlock status`'s daemon block, which is how a client tells the two apart. | `worker`                                                        |
| `capacity.strategy`               | Which policy decides how many devices may exist and run at once: `resource` or `fixed`. The options under `capacity.config` are that strategy's own -- see [Capacity strategies](#capacity-strategies).                     | `resource`                                                      |
| `idle.shutdownAfterMs`            | How long an unused device sits idle before Simlock shuts it down (tier 1, reclaims RAM).                                                                                                                                     | `10 minutes`                                                    |
| `idle.deleteAfterMs`              | How long a shut-down device sits idle before Simlock deletes it (tier 2, reclaims disk).                                                                                                                                     | `1 hour`                                                        |
| `warmPool.quarantine.maxRetries`  | Failed purge retries allowed on a quarantined device (after the triggering failure) before Simlock gives up and destroys it.                                                                                                | `3`                                                              |
| `warmPool.quarantine.retryBackoffMs` | Delay before the first quarantine purge retry.                                                                                                                                                                            | `30 seconds`                                                     |
| `warmPool.quarantine.retryBackoffMultiplier` | Growth factor applied to the backoff after each failed retry.                                                                                                                                                     | `2`                                                               |
| `warmPool.quarantine.maxRetryBackoffMs` | Cap on the quarantine retry backoff.                                                                                                                                                                                   | `5 minutes`                                                      |
| `lease.defaultTtlMs`              | TTL applied to a lease whose `lease.request` carried no `ttlMs` — **that request only**. It is *not* the renew fallback: a renew given no explicit TTL re-applies the lease's own stored width, so a lease granted for longer keeps it. A lease not renewed before its deadline expires and its device is reclaimed. | `15 minutes`                                                    |
| `lease.maxTtlMs`                  | Largest TTL a request or a renew may ask for. A larger `ttlMs` is rejected with `BAD_REQUEST` rather than silently clamped, so a caller is never left believing it has more time than it does.                               | `4 hours`                                                       |
| `http.enabled`                    | Master switch for the network-facing HTTP API (see [HTTP-API.md](HTTP-API.md)). Off by default; the daemon binds nothing until this is `true`.                                                                              | `false`                                                          |
| `http.host`                       | Address the HTTP listener binds. `127.0.0.1` keeps it loopback-only; reaching it remotely is the operator's own tunnel (Tailscale, cloudflared, reverse proxy) — Simlock does no TLS termination in v1.                     | `127.0.0.1`                                                      |
| `http.port`                       | Port the HTTP listener binds. Must be an integer `1`-`65535`.                                                                                                                                                                 | `4700`                                                           |
| `exec.timeoutMs`                  | How long a single `device.exec` command (the remote half of `simlock simctl` / `simlock adb` — see [CLI.md](CLI.md#reaching-a-leased-device)) may run before Simlock kills it and fails the call with `EXEC_TIMEOUT`. Output is streamed, never buffered, so there is no size limit to go with it.                                | `10 minutes`                                                     |
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
| `drivers.ios.deviceRoot`          | The CoreSimulator device set Simlock owns and scopes every `simctl` call to. See [Device roots](#device-roots).                                                                                              | `${SIMLOCK_HOME}/devices/ios`                                    |
| `drivers.android.deviceRoot`      | The AVD home Simlock owns; exported as `ANDROID_AVD_HOME` to every `avdmanager`/`emulator` call. See [Device roots](#device-roots).                                                                          | `${SIMLOCK_HOME}/devices/android`                                |
| `drivers.android.adbServerPort`   | TCP port for Simlock's own adb server. Must not be the shared server's `5037`. Startup fails closed if it is occupied.                                                                                       | `5038`                                                            |
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
`mode` must be exactly `"worker"` or `"gateway"`. `"gateway"` is *reachable*
in this release and inert: the config loads, the daemon starts, and
`simlock status` reports the mode, but nothing joins a gateway and no request
is dispatched anywhere until the gateway work lands (#117). Setting it today
buys a daemon that serves no devices.
`exec.timeoutMs` must be a positive number.
`lease.defaultTtlMs` and `lease.maxTtlMs` must be positive numbers, and
`lease.defaultTtlMs` must be `<=` `lease.maxTtlMs`. A config that violates
either rule is **rejected at load and the daemon does not start**, naming the
offending key — it is not clamped to something the operator did not write.
That is the opposite treatment from the retired keys below, which are only
warned about and ignored: an unrecognized key is a leftover, while a TTL pair
that contradicts itself has no safe interpretation to fall back on.

`lease.maxTtlMs` bounds what a request or a renew may **ask for**; it is not
re-applied to leases that already exist. A lease holding a larger stored
`ttlMs` — granted before an operator lowered the cap, or carried over from an
older record — keeps re-applying that width on every body-less renew, so
lowering the cap does not shorten it. Release it, or renew it once with an
explicit smaller `--ttl`, and the new width sticks from then on.
See [CLI.md](CLI.md#simlock-config-get-keyset-key-value) for the
`simlock config` command itself.

### Retired `lease.*` keys

[ADR 0004](adr/0004-ttl-first-leases-on-every-transport.md) collapsed the
held/detached lease split into one TTL-bound lease, which retired three keys.
**All three are simply unrecognized now** — `simlock config` warns about each
one and ignores it, exactly as it does for any other unknown key. None of
them is aliased onto a new key, so a config file that still sets one gets the
new key's default, not the value it wrote:

| Old key | What it did | What to write instead |
| --- | --- | --- |
| `lease.detachedTtlMs` | TTL for detached-mode leases. | `lease.defaultTtlMs`, which means the same thing for the one lease kind that is left. Copy the value across; it is not carried over for you. |
| `lease.heldTtlBackstopMs` | Backstop TTL behind a held lease. | Nothing. There is no separate backstop any more: a lease's TTL *is* its deadline. |
| `lease.heartbeatIntervalMs` | Daemon ping interval for held connections. | Nothing. The daemon-initiated heartbeat is gone; clients renew on their own timer. |

A warning rather than a hard failure keeps an old config bootable, and a
warning rather than an alias keeps the key set honest — there is one name for
this setting, and it is the one in the table above.

## Device roots

Simlock keeps every device it creates inside a root it owns, one per platform,
and scopes every platform command to that root. A simulator or emulator in a
Simlock root does not appear in Xcode, in Android Studio, or in a plain
`simctl list` / `adb devices`, and Simlock in turn cannot reach anything
outside it. See [ADR 0001](adr/0001-simlock-owned-device-roots.md) for why.

```
~/.simlock/devices/
├── ios/                    # drivers.ios.deviceRoot     → xcrun simctl --set
│   ├── .simlock-owned.json
│   └── <UDID>/
└── android/                # drivers.android.deviceRoot → ANDROID_AVD_HOME
    ├── .simlock-owned.json
    ├── simlock_<n>.ini
    └── simlock_<n>.avd/
```

Both roots default under `SIMLOCK_HOME`, so pointing `SIMLOCK_HOME` somewhere
else moves the devices with it. Override a single platform when its data
belongs on another volume — device data runs to tens of gigabytes:

```json
{
  "drivers": {
    "ios": { "deviceRoot": "/Volumes/scratch/simlock-ios" }
  }
}
```

A `deviceRoot` must be an absolute path. A relative one — or a value that is
not a string at all, such as `true` — refuses that one platform with reason
`not-absolute` rather than being resolved against whatever directory the daemon
happened to be started from; the daemon still comes up, and the other platform
is unaffected.

Roots hold device instances only. Runtimes and system images stay where Xcode
and the Android SDK put them.

### Ownership markers

Each root carries a `.simlock-owned.json` marker naming the Simlock instance
that owns it. Simlock creates the marker **only** for a root it creates empty
itself, and refuses any existing root that is unmarked, marked for another
instance, symlinked, or wrongly owned or permissioned. It never adopts a
directory it did not create. The instance identity lives in
`${SIMLOCK_HOME}/instance.json`, written once on first start.

A root that fails validation stops that platform's driver at startup — Simlock
fails closed rather than falling back to the default device location. `simlock
doctor` reports the reason.

### Simlock's adb server

Android containment needs one more thing, because `adb` has no equivalent of
`simctl --set`: Simlock runs its own adb server on `drivers.android.adbServerPort`
and gives its emulators console ports (5586–5682) above the range a default adb
server scans. That server is started with USB and mDNS disabled, so it never
competes with the shared server for physical devices or network targets, and it
refuses `adb kill-server`.

Containment runs in both directions, and the second half is easy to get wrong.
Simlock's server also has its emulator scanner turned off (`ADB_EMU=0`), because
the scan's lower bound is hard-coded at 5555: a server allowed to scan high
enough to find Simlock's emulators would also connect to *yours*, leaving two
adb servers driving one device. Simlock's emulators still attach, because an
emulator announces itself to the server it was told about — once, at its own
startup. Simlock re-sends that announcement itself for its own console range
(5586–5682) whenever it starts or adopts a server, and again for an emulator
that stays unreachable while booting; that is what keeps emulators that
outlived a `simlock daemon stop` visible to the daemon that comes next. Your
emulators are never announced, so they stay yours, and Simlock's stay
Simlock's.

If `drivers.android.adbServerPort` is occupied by a server Simlock did not
start, or is not a usable port, the Android driver does not start and `simlock
doctor` reports why (`occupied`, `start-failed`, `invalid-port`). Simlock never
attaches to a server it did not start. `occupied` is the one of those with no
automatic way out — `adb kill-server` is refused by design — so the error names
the two ways out: stop whatever holds the port (`lsof -nP -iTCP:<port>
-sTCP:LISTEN` names the pid), or move Simlock's own server with `simlock config
set drivers.android.adbServerPort <port>`.

Consequence worth knowing: your own `adb` will not see Simlock's emulators.
A lease hands you the port to use — see
[CLI.md](CLI.md#reaching-a-leased-device).

Running two Simlock instances on one machine now needs distinct
`drivers.android.adbServerPort` values as well as distinct `SIMLOCK_HOME`
values.

Slim mode is opt-in and iOS-only: it disables simulator daemon categories
that most agent workloads never touch, trading some simulator functionality
for a leaner runtime footprint. The categories are widgets, Siri/Apple
Intelligence, Spotlight/search, iCloud, App Store, mail/calendar (PIM),
Safari/web, Family Sharing, Health, Photos, bundled apps (News/Weather/Maps/
Tips/games), messaging, connectivity, telemetry, and a miscellaneous group
(`widgets`, `siri`, `search`, `icloud`, `store`, `pim`, `web`, `family`,
`health`, `photos`, `apps`, `messaging`, `connectivity`, `telemetry`,
`other` -- the valid `ios.slim.categories` strings, defined in
`src/drivers/ios/slim-labels.ts`). Measured on one simulator: ~258 -> ~70
processes, ~4.0 GB -> ~0.9 GB. It requires iOS 18.5 or newer, since the
underlying daemon controls are not available on older runtimes. Turning it
on costs an extra boot per device -- the daemons are disabled between a
first boot and a second, slower one -- which is why
`ios.slim.bootTimeoutMs` defaults higher than the normal boot timeout,
especially on slower CI runners.

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

# Configuration

Simlock reads `~/.simlock/config.json` and merges it over built-in
defaults. Only the keys below are recognized; unknown keys are ignored with
a warning. Inspect the effective, merged configuration at any time with
`simlock config`.

| Property                          | Description                                                                                                                                                                                                                  | Default                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `mode`                            | Which shape this daemon runs as: `worker` (owns devices on this machine) or `gateway` (owns none, fronts the workers that join it). See [Modes: gateway and worker](#modes-gateway-and-worker).                              | `worker`                                                        |
| `capacity.strategy`               | Which policy decides how many devices may exist and run at once: `resource` or `fixed`. The options under `capacity.config` are that strategy's own -- see [Capacity strategies](#capacity-strategies).                     | `resource`                                                      |
| `idle.shutdownAfterMs`            | How long an unused device sits idle before Simlock shuts it down (tier 1, reclaims RAM).                                                                                                                                     | `10 minutes`                                                    |
| `idle.deleteAfterMs`              | How long a shut-down device sits idle before Simlock deletes it (tier 2, reclaims disk).                                                                                                                                     | `1 hour`                                                        |
| `warmPool.quarantine.maxRetries`  | Failed purge retries allowed on a quarantined device (after the triggering failure) before Simlock gives up and destroys it.                                                                                                | `3`                                                              |
| `warmPool.quarantine.retryBackoffMs` | Delay before the first quarantine purge retry.                                                                                                                                                                            | `30 seconds`                                                     |
| `warmPool.quarantine.retryBackoffMultiplier` | Growth factor applied to the backoff after each failed retry.                                                                                                                                                     | `2`                                                               |
| `warmPool.quarantine.maxRetryBackoffMs` | Cap on the quarantine retry backoff.                                                                                                                                                                                   | `5 minutes`                                                      |
| `lease.defaultTtlMs`              | TTL applied to a lease whose `lease.request` carried no `ttlMs` — **that request only**. It is *not* the renew fallback: a renew given no explicit TTL re-applies the lease's own stored width, so a lease granted for longer keeps it. A lease not renewed before its deadline expires and its device is reclaimed. | `15 minutes`                                                    |
| `lease.maxTtlMs`                  | Largest TTL a request or a renew may ask for. A larger `ttlMs` is rejected with `BAD_REQUEST` rather than silently clamped, so a caller is never left believing it has more time than it does.                               | `4 hours`                                                       |
| `gateway.url`                     | **Worker side.** Base URL of the gateway this worker joins, e.g. `wss://gw.example:4700`; the worker dials `<url>/v1/uplink` and upgrades it to a WebSocket. Joining grants that gateway the `admin` role on this daemon, and `gateway.token` rides on the upgrade request as a bearer credential, so use `wss://` — or plain `ws://`/`http://` only over loopback or inside your own tunnel. Unset means "do not join a fleet": the default, and the only thing that changes about a joined worker.                    | unset                                                            |
| `gateway.token`                   | **Worker side.** The join token (`simlock token create --role worker`, minted on the gateway) this worker presents when it opens its uplink. Required whenever `gateway.url` is set.                                          | unset                                                            |
| `gateway.label`                   | **Worker side.** Display name for this worker in `simlock worker list`, `status`, the console, and on the lease's `worker` block. Display-only: nothing routes on it and it need not be unique.                              | the worker's own id                                              |
| `exec.timeoutMs`                  | **Worker side.** How long one `device.exec` command (`simlock simctl` / `simlock adb` against a gateway or over HTTP) may run before the worker kills it and the operation fails with `EXEC_TIMEOUT`. Authoritative: it bounds the process that actually runs. | `10 minutes`                                                     |
| `gateway.routing`                 | **Gateway side.** Which routing policy places a queued request on a worker. `warm-then-free` is the only policy in v1: warm hit first, then the most free running capacity for the platform. See [Routing](ARCHITECTURE.md#routing).                     | `warm-then-free`                                                 |
| `gateway.disconnectedRetentionMs` | **Gateway side.** How long a disconnected worker is kept (greyed, never dispatched to) before the gateway forgets it. The clock is held while the gateway still knows of gateway-issued leases on that worker, and that hold ends when the last of those leases passes its deadline.  | `24 hours`                                                       |
| `gateway.execTimeoutMs`           | **Gateway side.** How long the gateway waits on a proxied `device.exec` before giving up. A backstop for a worker that never answers at all — deliberately longer than the worker's own `exec.timeoutMs`, which is authoritative because that side owns the process and can kill it, so an ordinary timeout surfaces as the worker's `EXEC_TIMEOUT` rather than racing this one. See [ADR 0005](adr/0005-gateway-and-worker-modes.md) §19e. (ADR 0005 §19e gives ten minutes for both; equal values would make that authority a coin toss, so the default here is a minute longer.) | `11 minutes`                                                     |
| `http.enabled`                    | Master switch for the network-facing HTTP API (see [HTTP-API.md](HTTP-API.md)). Off by default; the daemon binds nothing until this is `true`. A gateway is the fleet's contact point, so it must be `true` there — see [Modes](#modes-gateway-and-worker). | `false`                                                          |
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
`mode` must be exactly `"worker"` or `"gateway"`. `gateway.url` must be an
absolute `ws`/`wss` (or `http`/`https`) URL and `gateway.token` a non-empty
string; **in `mode: "worker"`**, setting either without the other is rejected
at load and the daemon does not start, because a half-configured uplink would
otherwise come up looking like an ordinary standalone worker. That rule does
not apply in `mode: "gateway"`, where both keys are worker-side and are
warned about and ignored like every other worker key — a gateway is not
misconfigured by leftovers from the config it was flipped out of.
`gateway.label` is a non-empty string, `gateway.routing` one of the
registered routing policies, and `exec.timeoutMs`, `gateway.execTimeoutMs`,
and `gateway.disconnectedRetentionMs` positive numbers.
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

## Modes: gateway and worker

`mode` decides what the daemon this config belongs to *is*, so it also
decides which of the keys above mean anything ([ADR
0005](adr/0005-gateway-and-worker-modes.md)). One daemon runs exactly one
mode; `simlock daemon start` starts whichever is configured, and switching is
`simlock config set mode gateway` followed by a restart.

**A worker (`mode: "worker"`, the default) reads every key in this
document.** It is today's simlock, unchanged. Joining a fleet adds exactly
two keys — `gateway.url` and `gateway.token` — plus the optional
`gateway.label`, and changes nothing else about it: same drivers, same
registry, same capacity limits, same local unix socket, and its own local
agents keep leasing from it as before. `http.enabled` is *not* required for a
worker, because the uplink is outbound.

**A gateway (`mode: "gateway"`) owns no devices**, so most of this document
does not apply to it. It reads:

| Key group | Why |
|---|---|
| `mode` | to be a gateway at all |
| `gateway.routing`, `gateway.disconnectedRetentionMs`, `gateway.execTimeoutMs` | how to run the fleet |
| `http.*` | it is the fleet's contact point |
| `lease.*` | `defaultTtlMs`/`maxTtlMs` bound what its own clients may ask for, before a request is dispatched — see below |
| `log.*`, `eventBuffer.*` | logging and the event ring buffer, as anywhere |

**Both ends have a `lease.*` block, and on a fleet lease the gateway's is the
one that decides the width.** A request arriving at a gateway with no `ttlMs`
is filled in with the *gateway's* `lease.defaultTtlMs` before it is dispatched
anywhere, and one asking for more than the *gateway's* `lease.maxTtlMs` is
`BAD_REQUEST` at the gateway and never reaches a worker at all. The worker's
own cap still applies to what it is handed, though — it is an ordinary
`lease.request` to the worker, so a worker whose `lease.maxTtlMs` is lower
refuses it, and the client sees that failure after a dispatch rather than
before one. So **keep the gateway's `lease.maxTtlMs` at or below every
worker's**, or requests that the gateway happily accepts will fail on
whichever machine they land on, which is the least debuggable version of this
mistake.

Everything else — `capacity.*`, `idle.*`, `warmPool.*`, `health.*`,
`stalledTransition.*`, `drivers.*`, `ios.slim.*`, `diskPressure.*`,
`downloads.*`, and the worker-side `gateway.url`/`gateway.token`/
`gateway.label`/`exec.timeoutMs` — is **ignored with a warning**, exactly as
an unknown key is. That is deliberately the softer treatment: a gateway's
config file is usually a worker's config file with `mode` flipped, and a
warning names each key that stopped mattering rather than refusing to start
over a leftover.

There is one hard failure: **`mode: "gateway"` with `http.enabled: false` is
rejected at load and the daemon does not start**, naming the key. A gateway
with no HTTP listener is unreachable by definition — no worker could open an
uplink to it and no agent could lease through it — so there is no safe way to
interpret that pair, the same reasoning that rejects a `lease.defaultTtlMs`
above `lease.maxTtlMs`.

The `gateway.*` block reads in both directions on purpose: on a worker it
says *which gateway to join*, on a gateway it says *how to be one*. The table
above marks which is which, and each key is only ever read in one mode.

A machine that should both front a fleet and own devices runs **two daemons**:
one gateway, one worker, the worker joining the gateway over localhost. There
is no hybrid mode. What the two need to keep apart is smaller than it looks,
because only one of them owns anything:

- **Distinct `SIMLOCK_HOME`s.** That is what gives them separate config,
  state, sockets, logs, instance ids, and token stores — and the separate
  instance ids are what make the worker a distinct member of the fleet.
- **Only the gateway needs `http.enabled`** (and must have it). The worker
  dials out, so it needs no listener of its own; leave its `http.enabled`
  off unless you also want to reach that one worker directly.
- **Distinct `http.port`s, if you do enable HTTP on both.** A port is
  machine-global and `SIMLOCK_HOME` cannot isolate it.
- **The worker keeps its `drivers.*` block** — device roots, adb server
  port, the lot. It owns the devices; the gateway has no drivers to
  configure. Two *workers* on one machine would additionally need distinct
  `drivers.android.adbServerPort` values (see below), but a gateway plus a
  worker is one driver set, so there is nothing to split.

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

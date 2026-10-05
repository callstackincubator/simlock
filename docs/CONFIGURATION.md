# Configuration

Simlock reads `~/.simlock/config.json` and merges it over built-in
defaults. Only the keys below are recognized; unknown keys are ignored with
a warning. Inspect the effective, merged configuration at any time with
`simlock config`.

`simlock config set` writes `config.json` readable and writable by your user
only (mode `0600`), because it can hold `gateway.token`. A file you create or
edit yourself keeps the mode you give it until the next `config set`; run
`chmod 600 ~/.simlock/config.json` on one that holds a token.

| Property                          | Description                                                                                                                                                                                                                  | Default                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `mode`                            | Which shape this daemon runs as: `worker` (owns devices on this machine) or `gateway` (owns none, fronts the workers that join it). See [Modes: gateway and worker](#modes-gateway-and-worker).                              | `worker`                                                        |
| `capacity.strategy`               | Which policy decides how many devices may exist and run at once: `resource` or `fixed`. The options under `capacity.config` are that strategy's own -- see [Capacity strategies](#capacity-strategies).                     | `resource`                                                      |
| `idle.shutdownAfterMs`            | How long an unused device sits idle before Simlock shuts it down (tier 1, reclaims RAM).                                                                                                                                     | `10 minutes`                                                    |
| `idle.deleteAfterMs`              | How long a shut-down device sits idle before Simlock deletes it (tier 2, reclaims disk).                                                                                                                                     | `1 hour`                                                        |
| `warmPool.quarantine.maxRetries`  | Failed purge retries allowed on a quarantined device (after the triggering failure) before Simlock gives up and destroys it. A device created under `lease.identity` `fresh` retries its delete instead of a purge.         | `3`                                                              |
| `warmPool.quarantine.retryBackoffMs` | Delay before the first quarantine purge retry.                                                                                                                                                                            | `30 seconds`                                                     |
| `warmPool.quarantine.retryBackoffMultiplier` | Growth factor applied to the backoff after each failed retry.                                                                                                                                                     | `2`                                                               |
| `warmPool.quarantine.maxRetryBackoffMs` | Cap on the quarantine retry backoff.                                                                                                                                                                                   | `5 minutes`                                                      |
| `lease.defaultTtlMs`              | TTL applied to a lease whose `lease.request` carried no `ttlMs` — **that request only**. It is *not* the renew fallback: a renew given no explicit TTL re-applies the lease's own stored width, so a lease granted for longer keeps it. A lease not renewed before its deadline expires and its device is reclaimed. | `15 minutes`                                                    |
| `lease.maxTtlMs`                  | Largest TTL a request or a renew may ask for. A larger `ttlMs` is rejected with `BAD_REQUEST` rather than silently clamped, so a caller is never left believing it has more time than it does.                               | `4 hours`                                                       |
| `lease.identity.ios`              | Whether iOS leases reuse simulators. `reusable` erases a released simulator and returns it to the pool. `fresh` creates a simulator for each lease and deletes it when the lease ends — by release, by expiry, or because the device was lost — so no simulator serves two leases. If the delete fails, the simulator is quarantined, never leased again, and the delete is retried. **Boot cost:** under `fresh`, no simulator stays warm after a release, so every lease pays a full boot (about 30 seconds on an Apple silicon Mac). Each device keeps the setting it was created with, even if you change this value later. | `reusable`                                                      |
| `lease.identity.android`          | The same setting for Android emulators. `fresh` is accepted, but it is designed for iOS.                                                                                                                                                | `reusable`                                                      |
| `lease.requestRetentionMs`        | How long a settled lease request stays stored, counted from when it settled. A client that repeats a request with the same `idempotencyKey` inside this window gets the stored result back; after it, the record is removed and the same key starts a new request. | `10 minutes`                                                    |
| `lease.maxRequestRecords`         | The most lease-request records Simlock keeps. When a new request would go over it, the oldest settled record is removed. A request that is still open is never removed. | `10000`                                                         |
| `gateway.url`                     | **Worker side.** Base URL of the gateway this worker joins, e.g. `wss://gw.example:4700`; the worker dials `<url>/v1/uplink` and upgrades it to a WebSocket. Joining grants that gateway the `admin` role on this daemon, and `gateway.token` rides on the upgrade request as a bearer credential, so use `wss://` — or plain `ws://` only over loopback or inside your own tunnel. `http://` and `https://` are rejected at load. Unset means "do not join a fleet": the default, and the only thing that changes about a joined worker.                    | unset                                                            |
| `gateway.token`                   | **Worker side.** The join token (`simlock token create --role worker`, minted on the gateway) this worker presents when it opens its uplink. Required whenever `gateway.url` is set. `simlock config` shows it; the daemon log and the `daemon.started` event show `[redacted]`. It is stored in plain text in `config.json`, which `simlock config set` writes owner-only.                                          | unset                                                            |
| `gateway.label`                   | **Worker side.** Display name for this worker in `simlock worker list`, `status`, the console, and on the lease's `worker` block. Display-only: nothing routes on it and it need not be unique.                              | the worker's own id                                              |
| `exec.timeoutMs`                  | **Worker side.** How long one `device.exec` command (`simlock simctl` / `simlock adb` against a gateway or over HTTP) may run before the worker kills it and the operation fails with `EXEC_TIMEOUT`. Authoritative: it bounds the process that actually runs. | `10 minutes`                                                     |
| `gateway.routing`                 | **Gateway side.** Which routing policy places a queued request on a worker. `warm-then-free` is the only policy in v1. Among the workers that can serve the request, in order: a worker whose health is not `running`, or that has requests of its own waiting, is left out; a worker holding a ready device that fits goes first; otherwise a worker with no free running slot for the platform or overall is left out (a running device that is not leased counts as free: the worker shuts it down to make room), a worker under its RAM budget for the platform is preferred over one at it (a worker at its budget is still asked when it is the only one left), and the one with the most free running capacity for the platform wins. A worker that is left out is busy, not unable: the request waits for it. Ties go to the lowest worker id. | `warm-then-free`                                                 |
| `gateway.disconnectedRetentionMs` | **Gateway side.** How long a disconnected worker is kept (greyed, never dispatched to) before the gateway forgets it. The clock is held while the gateway still knows of gateway-issued leases on that worker, and that hold ends when the last of those leases passes its deadline.  | `24 hours`                                                       |
| `gateway.execTimeoutMs`           | **Gateway side.** How long the gateway waits on a proxied `device.exec` before giving up. A backstop for a worker that never answers at all — deliberately longer than the worker's own `exec.timeoutMs`, which is authoritative because that side owns the process and can kill it, so an ordinary timeout surfaces as the worker's `EXEC_TIMEOUT` rather than racing this one. | `11 minutes`                                                     |
| `gateway.leaseRequestTimeoutMs`   | **Gateway side.** How long the gateway waits on a forwarded `lease.request` before giving up on that worker for this request, answering `WORKER_UNREACHABLE`. Bounds the one uplink call that otherwise had no timeout of its own, so a wedged worker cannot park a request where neither a deadline nor `lease.cancel` could ever reach it again. Generous against a cold device provision-plus-boot; well below `gateway.execTimeoutMs`, since granting a lease should never take as long as a command run against the device afterward. | `5 minutes`                                                      |
| `http.enabled`                    | Master switch for the network-facing HTTP API (see [HTTP-API.md](HTTP-API.md)) and the web console served beside it (see [CONSOLE.md](CONSOLE.md)). Off by default; the daemon binds nothing until this is `true`. A gateway is the fleet's contact point, so it must be `true` there — see [Modes](#modes-gateway-and-worker). | `false`                                                          |
| `http.host`                       | Address the HTTP listener binds. `127.0.0.1` keeps it loopback-only; reaching it remotely is the operator's own tunnel (Tailscale, cloudflared, reverse proxy) — Simlock does no TLS termination in v1.                     | `127.0.0.1`                                                      |
| `http.port`                       | Port the HTTP listener binds. Must be an integer `1`-`65535`.                                                                                                                                                                 | `4700`                                                           |
| `exec.timeoutMs`                  | How long a single `device.exec` command (the remote half of `simlock simctl` / `simlock adb` — see [CLI.md](CLI.md#reaching-a-leased-device)) may run before Simlock kills it and fails the call with `EXEC_TIMEOUT`. Output is streamed, never buffered, so there is no size limit to go with it.                                | `10 minutes`                                                     |
| `gateway.url`                     | **Worker side.** The gateway's base URL (`ws://host:port` or `wss://...`); the worker derives the uplink endpoint (`/v1/uplink`) from it. Set together with `gateway.token`, or not at all.                                  | unset (this worker has no gateway)                              |
| `gateway.token`                   | **Worker side.** The join token this worker presents, minted on the gateway with `simlock token create --role worker`.                                                                                                        | unset                                                            |
| `gateway.label`                   | **Worker side.** Display name for this worker in the gateway's views. Need not be unique, and is never used to route.                                                                                                         | unset (views show the worker's id)                              |
| `gateway.disconnectedRetentionMs` | **Gateway side.** How long a disconnected worker's view is kept before the gateway forgets it. The clock only applies once every lease on that view has passed its deadline.                                                  | `24 hours`                                                       |
| `gateway.execTimeoutMs`           | **Gateway side.** Backstop on a proxied `device.exec`, deliberately longer than the worker's own `exec.timeoutMs`, which is the authoritative one.                                                                            | `11 minutes`                                                     |
| `gateway.leaseRequestTimeoutMs`   | **Gateway side.** Backstop on a forwarded `lease.request` -- expiry answers `WORKER_UNREACHABLE`, freeing the request for the queue's own deadline/cancel handling again.                                                    | `5 minutes`                                                      |
| `downloads.policy`                | Who may start a download of a missing simulator runtime / system image: `never`, `on-request` or `always`. Downloads are multi-GB and never implicit. See [Downloads](#downloads). | `on-request` |
| `downloads.acceptAndroidLicenses` | Accept the Android SDK licenses an Android system image install asks for. A separate switch from `downloads.policy`: allowing a download does not accept a license. | `false` |
| `downloads.timeoutMs`             | How long one request for a missing runtime / system image may take, counted from the moment it arrives. Waiting behind another download on the same platform counts too, and the clock never restarts; a request that runs out fails with `DOWNLOAD_TIMEOUT`. A running download is stopped when the oldest request sharing it runs out, and every request sharing it fails then. On a busy machine, raise it. | `20 minutes`                                                     |
| `diskPressure.freeBytesThreshold` | Free disk space below which Simlock treats the machine as under disk pressure.                                                                                                                                               | `10 GiB`                                                         |
| `eventBuffer.capacity`            | Number of recent business events kept in memory, which `simlock events` without `--since` replays.                                                                                                                                          | `1000`                                                           |
| `eventLog.rotateBytes`            | Size of the event file, `~/.simlock/events.jsonl`, before it rotates. Every business event is written there and survives a daemon restart. One rotated generation, `events.jsonl.1`, is kept, so the history on disk stays within about twice this size and the oldest events are dropped first. | `5 MiB`                                                          |
| `log.level`                       | Lowest level written to `daemon.log`: `debug`, `info`, `warn`, or `error`. `debug` adds a line for every request that only reads (such as `simlock status`) and for every device command Simlock runs (`simctl`, `adb`, …) with its arguments and exit code. | `info`                                                           |
| `log.rotateBytes`                 | Size at which `daemon.log` is rotated to `daemon.log.1`. One rotated file is kept.                                                                                                                                          | `5 MiB`                                                          |
| `health.enabled`                  | Master switch for leased-device crash detection and recovery.                                                                                                                                                                | `true`                                                           |
| `health.probeIntervalMs`          | How often the health monitor observes leased devices against driver reality.                                                                                                                                                | `30 seconds`                                                     |
| `health.stableObservations`       | Consecutive `stopped` observations required before a leased device is treated as crashed; guards against transient `Booting`/`Shutting Down`/adb-offline readings.                                                         | `2`                                                               |
| `health.maxRecoveryAttempts`      | Reboot attempts for one lease before the lease is given up as lost.                                                                                                                                                          | `3`                                                               |
| `health.recoveryBackoffMs`        | Base delay between reboot attempts; the monitor applies exponential backoff over it.                                                                                                                                        | `5 seconds`                                                      |
| `health.maxConcurrentRecoveries`  | Cap on simultaneous recovery reboots, so a machine wake (every device reads `stopped` at once) cannot start a boot storm.                                                                                                   | `1`                                                               |
| `stalledTransition.thresholdMultiplier` | Factor applied to a driver's own `provision + boot` (for `provisioning`) or `reclaim` (for `reclaiming`) estimate to get the stall threshold: past it, `simlock doctor` reports a `stalled-transition` finding and `simlock status` marks the device `stalled`. | `3`                                                               |
| `stalledTransition.minimumThresholdMs` | Floor under the multiplied estimate, for a driver whose estimate is near zero.                                                                                                                                | `1 minute`                                                        |
| `drivers.ios.deviceRoot`          | The CoreSimulator device set Simlock owns and scopes every `simctl` call to. See [Device roots](#device-roots).                                                                                              | `${SIMLOCK_HOME}/devices/ios`                                    |
| `drivers.android.deviceRoot`      | The AVD home Simlock owns; exported as `ANDROID_AVD_HOME` to every `avdmanager`/`emulator` call. See [Device roots](#device-roots).                                                                          | `${SIMLOCK_HOME}/devices/android`                                |
| `drivers.android.adbServerPort`   | TCP port for Simlock's own adb server. Must not be the shared server's `5037`. Startup fails closed if it is occupied.                                                                                       | `5038`                                                            |
| `ios.defaultMode`                 | The device mode an iOS lease request gets when it names none: `slim` or `full`. Every worker makes both kinds whatever this says. See [Device mode: slim and full](#device-mode-slim-and-full).                             | `full`                                                           |
| `ios.slim.categories`             | Which daemon categories a slim iOS device has disabled. Omitted means every category the driver knows.                                                                                                                       | every known category                                             |
| `ios.slim.bootTimeoutMs`          | Boot deadline for a slim iOS device, in place of the normal boot timeout.                                                                                                                                                    | `10 minutes`                                                     |
| `ios.defaultModels.<class>`       | The iOS models to prefer for a device class (`phone`, `tablet`, `watch`, `tv`, `vision`, `auto` or `desktop`): one model name or a list of them, most preferred first. Tried before Simlock's own list. See [Default models per class](#default-models-per-class). | unset (Simlock's own list only)                                  |
| `android.defaultModels.<class>`   | The same for Android models. | unset (Simlock's own list only)                                  |
| `android.emulator.headless`       | Launch emulators without a window (`-no-window`). Needed on a host with no display, such as a Linux CI runner. See [Android emulator launch options](#android-emulator-launch-options). | `false`                                                          |
| `android.emulator.gpu`            | The emulator's GPU mode, passed as `-gpu <mode>` (for example `host`, `swiftshader_indirect`, `guest`). `auto` passes nothing and leaves the emulator's own choice.                                                        | `auto`                                                           |
| `android.emulator.audio`          | `false` launches emulators without audio (`-no-audio`).                                                                                                                                                                      | `true`                                                           |
| `android.emulator.bootAnimation`  | `false` launches emulators without the boot animation (`-no-boot-anim`).                                                                                                                                                     | `true`                                                           |

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
`mode` is `worker` or `gateway`; `gateway.url`, `gateway.token` and
`gateway.label` are strings, and `gateway.disconnectedRetentionMs`,
`gateway.execTimeoutMs`, and `gateway.leaseRequestTimeoutMs` positive
numbers.
`ios.defaultMode` is `slim` or `full`, `ios.slim.categories` an array of
non-empty strings, and `ios.slim.bootTimeoutMs` a positive number.
`android.emulator.headless`, `android.emulator.audio`, and
`android.emulator.bootAnimation` are booleans, and `android.emulator.gpu` a
non-empty string. Any other value is rejected at load, and the error names the
key. Simlock does not check that a `gpu` string names a mode the emulator
knows: a mode the emulator rejects fails that device's next boot, not the
config load.
`mode` must be exactly `"worker"` or `"gateway"`. `gateway.url` must be an
absolute `ws`/`wss` URL — `http`/`https` are rejected — and `gateway.token`
a non-empty string; **in `mode: "worker"`**, setting either without the other
is rejected at load and the daemon does not start, because a half-configured
uplink would otherwise come up looking like an ordinary standalone worker. That rule does
not apply in `mode: "gateway"`, where both keys are worker-side and are
warned about and ignored like every other worker key — a gateway is not
misconfigured by leftovers from the config it was flipped out of.
`gateway.label` is a non-empty string, `gateway.routing` one of the
registered routing policies, and `exec.timeoutMs`, `gateway.execTimeoutMs`,
`gateway.leaseRequestTimeoutMs`, and `gateway.disconnectedRetentionMs`
positive numbers.
**`mode: "gateway"` with `http.enabled: false` is rejected at load**, naming the key: a
gateway is the fleet's contact point over HTTP, so one nothing can reach has
no safe reading.
`lease.identity.ios` and `lease.identity.android` must each be `reusable` or
`fresh`. Any other value is rejected at load, and the error names the key.
No lease request can change this setting.

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

## Gateway and worker modes

`mode` selects what `simlock daemon start` starts. The default, `worker`, is what
every simlock daemon has always been. `gateway` is a daemon that owns no
devices and fronts the workers connected to it.

**Joining a fleet takes two keys on the worker**, and they are required
together: `gateway.url` (the gateway's base URL) and `gateway.token` (a join
token minted on the gateway with `simlock token create --role worker`). One
without the other fails the start naming the missing key — a worker that
silently never joined would look exactly like one whose gateway is down.
`gateway.url` must be a `ws://` or `wss://` URL, checked at load rather than
at dial time, so a typo names the key instead of surfacing as an endless
reconnect loop. Nothing else about the worker changes: it keeps serving its
local agents whether or not its gateway is reachable, and `http.enabled` stays
off by default.

**A gateway reads a deliberately small slice of this file**: `mode`, `http.*`,
`log.*`, `lease.*`, `eventBuffer.*`, `eventLog.*` and `gateway.*`. Every other key —
capacity, drivers, downloads, idle, warmPool, health, ios, android, stalledTransition —
configures devices, which a gateway does not have; each one present in a
gateway's config is reported with a warning and ignored, the same treatment an
unknown key gets. The worker-side `gateway.url`/`token`/`label` are warned
about there too. Nothing is stripped: the same file can be copied between a
worker and a gateway with only `mode` differing, and the warning is what makes
the difference visible rather than silent.

**`http.enabled` is not optional for a gateway.** It defaults to `true` in
gateway mode (it stays `false` for a worker), and an explicit `false` fails the
start naming the key. HTTP is how agents reach a fleet *and* what the worker
uplink upgrades from, so a gateway without it is a process nothing can reach
and no worker can join — quietly overriding the operator's value would be
worse than refusing it. Switching a daemon between modes is therefore a
two-key edit, `mode` and (if it was set) `http.enabled`.

The gateway keeps one small file of its own beside `tokens.json`:
`workers.json`, owner-only, holding the ids of workers an operator has
drained. Drain is a decision about a machine rather than something the machine
reports, so it has to survive both the worker's reconnect and a gateway
restart; every other part of a worker view is rebuilt from the worker itself.

### Retired `lease.*` keys

A collapse of the
held/detached lease split into one TTL-bound lease retired three keys.
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
decides which of the keys above mean anything. One daemon runs exactly one
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
| `gateway.routing`, `gateway.disconnectedRetentionMs`, `gateway.execTimeoutMs`, `gateway.leaseRequestTimeoutMs` | how to run the fleet |
| `http.*` | it is the fleet's contact point |
| `lease.*` | `defaultTtlMs`/`maxTtlMs` bound what its own clients may ask for, before a request is dispatched — see below |
| `log.*`, `eventBuffer.*`, `eventLog.*` | logging and the event history, as anywhere |

**A worker's `downloads.policy` does not apply to requests through a
gateway.** The gateway sends a request only to a worker whose catalog already
has what it asks for: the model under any name the worker lists for it, in
any letter case, paired with the requested runtime (or, with none requested,
with at least one installed runtime). It never asks a worker to download, so
`--allow-download` has no effect through a gateway, whatever each worker's
policy says.

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

The gateway does not enforce this for you — clamping its own cap to the
minimum of its workers' would make fleet policy shift as machines come and
go, and the gateway's cap is meant to be explicit policy, not a computed
minimum. What it does instead: when a worker's own reported `lease.maxTtlMs`
is below the gateway's, the gateway logs a warning naming the worker and
both values the moment that worker's view is built (at join, and again if
the mismatch changes on a later refresh) — loud enough to catch the
misconfiguration without silently overriding it.

Everything else — `capacity.*`, `idle.*`, `warmPool.*`, `health.*`,
`stalledTransition.*`, `drivers.*`, `ios.*`, `android.emulator.*`, `diskPressure.*`,
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

## Downloads

A missing iOS simulator runtime or Android system image is downloaded only
with explicit consent. There are two ways to ask: a lease request with
`--allow-download`, and `simlock component install`, which an operator runs
to prepare a machine and which is itself the consent. `downloads.policy`
decides which of them may start a download:

| `downloads.policy` | Lease without `--allow-download` | Lease with `--allow-download` | `simlock component install` |
|---|---|---|---|
| `never` | refused | refused | refused (`DOWNLOADS_DISABLED`) |
| `on-request` | refused | allowed | allowed |
| `always` | allowed | allowed | allowed |

`never` is absolute: no role and no command overrides it. A machine that
should never download anything sets it, and its operator installs components
with the platform's own tools. Warm-pool provisioning and startup never
download under any policy, and neither does an Android lease that names an
image tag (`--image-tag`): it uses only an installed image of that tag.

A gateway has no download policy of its own. `simlock component install
--worker`/`--all-workers` asks each worker, and each worker's own
`downloads.policy` and `downloads.timeoutMs` decide.

A platform downloads one component at a time, whichever way it was asked
for; a request for the component already downloading joins that download.
Every request has `downloads.timeoutMs` to finish, waiting included.

## Device roots

Simlock keeps every device it creates inside a root it owns, one per platform,
and scopes every platform command to that root. A simulator or emulator in a
Simlock root does not appear in Xcode, in Android Studio, or in a plain
`simctl list` / `adb devices`, and Simlock in turn cannot reach anything
outside it.

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

## Device mode: slim and full

A lease request can ask for a `slim` or a `full` device (`simlock lease
--mode`, `mode` on MCP, HTTP, and the client). A request that names no mode
gets the default of the worker that serves it, set by `ios.defaultMode`
(default `full`). Every worker makes both kinds of device whatever its
default is, and keeps them apart: a request only ever reuses an idle device
of the mode it resolved to.

```json
{
  "ios": {
    "defaultMode": "slim",
    "slim": { "categories": ["widgets", "siri", "telemetry"] }
  }
}
```

A slim iOS device has simulator daemon categories disabled that most agent
workloads never touch, trading some simulator functionality for a leaner
runtime footprint. The categories are widgets, Siri/Apple Intelligence,
Spotlight/search, iCloud, App Store, mail/calendar (PIM), Safari/web, Family
Sharing, Health, Photos, bundled apps (News/Weather/Maps/Tips/games),
messaging, connectivity, telemetry, and a miscellaneous group (`widgets`,
`siri`, `search`, `icloud`, `store`, `pim`, `web`, `family`, `health`,
`photos`, `apps`, `messaging`, `connectivity`, `telemetry`, `other` -- the
valid `ios.slim.categories` strings). Measured on one simulator: ~258 -> ~70
processes, ~4.0 GB -> ~0.9 GB. A slim device costs an extra boot -- the
daemons are disabled between a first boot and a second, slower one -- which
is why `ios.slim.bootTimeoutMs` defaults higher than the normal boot timeout,
especially on slower CI runners. The `ios.slim.*` keys apply to every slim
device the worker makes, whatever its default mode.

**`full` is a guarantee; `slim` is best effort.** A `full` request never
receives a slim device. A `slim` request on a runtime that cannot be slimmed
-- an iOS runtime older than 18.5, or any Android device -- is granted a full
device rather than failing. The lease reports the mode the device actually
has as `mode`, so check it when it matters.

On a worker whose default mode is `slim`, `simlock doctor` reports the
installed iOS runtimes that cannot be slimmed.

**Upgrading a worker that had slim switched on.** The old on/off switch under
`ios.slim` is gone; a config that still sets it gets the usual unknown-key
warning and the default mode `full`. Set `ios.defaultMode: "slim"` to keep slim as the
default. Devices made before the upgrade load as full, including ones that
were slimmed, so such a worker could hand a slimmed device to a `full`
request. Empty it before upgrading:

```bash
simlock nuke --delete-devices
```

## Default models per class

For each device class (`phone`, `tablet`, `watch`, `tv`, `vision`, `auto`,
`desktop`) Simlock keeps a preference list of model names, and the default
model for the class on this machine is the first name on it that qualifies.
`simlock catalog` shows the result beside each class, as `classDefaults` in
its JSON. A name qualifies when this machine's catalog lists it (by its name
or another name it answers to, in any letter case), when the catalog says it
is a model of that class, and when it pairs with at least one installed
runtime. When no listed name of the class pairs with a runtime, the first
listed one is shown anyway. A class in which no name qualifies has no default,
and the catalog shows `none`.

The list is the names you set, then Simlock's own list for the platform:

| Class     | iOS, newest first                                                                                                 | Android, newest first                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `phone`   | iPhone 17, iPhone 16, iPhone 15, iPhone 14, iPhone 13                                                              | Pixel 9, Pixel 8, Pixel 7, Pixel 6, Medium Phone          |
| `tablet`  | iPad Pro 11-inch (M5), iPad Pro 11-inch (M4), iPad Air 11-inch (M3), iPad (A16), iPad (10th generation)            | none                                                      |
| `watch`   | Apple Watch Series 11 (46mm), Apple Watch Series 10 (46mm), Apple Watch Series 9 (45mm)                            | Wear OS Large Round, Wear OS Small Round                  |
| `tv`      | Apple TV 4K (3rd generation), Apple TV                                                                             | Television (1080p), Television (4K)                       |
| `vision`  | Apple Vision Pro                                                                                                   | none                                                      |
| `auto`    | none                                                                                                               | Automotive (1080p landscape), Automotive (1024p landscape) |
| `desktop` | none                                                                                                               | Medium Desktop, Large Desktop                             |

Set `ios.defaultModels.<class>` or `android.defaultModels.<class>` to one
model name, or to a non-empty list of them:

```json
{
  "ios": { "defaultModels": { "phone": "iPhone 15", "tablet": ["iPad (A16)", "iPad (10th generation)"] } },
  "android": { "defaultModels": { "phone": "Pixel 7" } }
}
```

An empty string, an empty list, a list with an empty string, and a key that is
not a class are refused when the config loads. A name that is not a model of
that class on this machine is skipped, not an error: with `ios.defaultModels.phone`
set to an iPad, the `phone` default is the first of Simlock's own names that
qualifies. Which class a model belongs to is what the platform's tools report;
see `modelClasses` in [`simlock catalog`](CLI.md#simlock-catalog---platform-iosandroid---json).

## Android emulator launch options

`android.emulator` sets how this machine's Android emulators are launched.
By default each one opens a window, uses the emulator's default GPU mode,
plays audio, and shows the boot animation. Set it once, in the config file;
no lease request, MCP call, or HTTP request can change it.

```json
{
  "android": {
    "emulator": {
      "headless": true,
      "gpu": "swiftshader_indirect",
      "audio": false,
      "bootAnimation": false
    }
  }
}
```

**A change applies at a device's next boot.** A running emulator keeps the
flags it started with; restart the daemon to load the new config, and each
device picks it up the next time it boots.

**Changing `headless` or `gpu` rebuilds a device's clean snapshot.** Simlock
resets an Android device between leases by loading a clean snapshot, and a
snapshot taken under one window or GPU mode does not load cleanly under
another. So on the next boot after either key changes, Simlock wipes the
device and captures a fresh snapshot, instead of letting every later reset
fall back to a full wipe. Changing `audio` or `bootAnimation` keeps the
snapshot.

Only these four keys exist. There is no way to pass other emulator
arguments from config, so nothing here can move an emulator's port or AVD
home.

## Capacity strategies

How many devices Simlock lets exist and run at once is decided by a capacity
strategy. `capacity.strategy` picks one; `capacity.config` holds that
strategy's own options, so its shape depends on the strategy you selected.

### `resource` (default)

Device and running ceilings derived from the machine, with a RAM budget on
top: a device is only created if its budgeted RAM still fits under the
machine's total, minus 4 GiB left for the OS. Each device that has booted
counts by its own mode, at the slim or the full size for its platform. A
device that has not booted yet counts at the full size.

| Property                                        | Description                                                     | Default                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `capacity.config.limits.maxRunning`             | Global cap on devices running at once, across both platforms.   | Sum of the two `maxDevices` values                                          |
| `capacity.config.limits.ios.maxDevices`         | Max iOS simulators Simlock will manage at once.                 | `max(1, cpuCount / 2)`                                                      |
| `capacity.config.limits.ios.maxRunning`         | Max iOS simulators running at once.                             | Same as `capacity.config.limits.ios.maxDevices`                             |
| `capacity.config.limits.android.maxDevices`     | Max Android emulators Simlock will manage at once.              | `max(1, min(cpuCount / 4, totalRamGb / 8))`                                 |
| `capacity.config.limits.android.maxRunning`     | Max Android emulators running at once.                          | Same as `capacity.config.limits.android.maxDevices`                         |
| `capacity.config.ramBudget.iosBytesPerDevice`   | RAM reserved per iOS simulator when computing capacity.         | `1.5 GiB`                                                                    |
| `capacity.config.ramBudget.androidBytesPerDevice` | RAM reserved per Android emulator when computing capacity.    | `4 GiB`                                                                      |
| `capacity.config.ramBudget.iosSlimBytesPerDevice` | RAM reserved per slim iOS simulator. Optional. | `capacity.config.ramBudget.iosBytesPerDevice` |
| `capacity.config.ramBudget.androidSlimBytesPerDevice` | RAM reserved per slim Android emulator. Optional; has no effect yet, because Android devices are always full. | `capacity.config.ramBudget.androidBytesPerDevice` |

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

#### Sizing slim and full devices

A worker can hold slim and full devices side by side (see
[Device mode: slim and full](#device-mode-slim-and-full)), and the RAM
budget counts each one at the size of the mode it has:

```json
{
  "capacity": {
    "strategy": "resource",
    "config": {
      "limits": {
        "maxRunning": 12,
        "ios": { "maxDevices": 12, "maxRunning": 12 }
      },
      "ramBudget": {
        "iosBytesPerDevice": 4294967296,
        "iosSlimBytesPerDevice": 1073741824
      }
    }
  }
}
```

- **With no slim size set**, a slim device counts at its platform's full
  size, so nothing changes for an existing config.
- **Every new device needs room for the full size.** A slim device boots
  full and is slimmed after, so it uses the full size until then. A device
  counts at the full size until it has booted, whatever mode it asked for.
  Booting a shut-down slim device needs the same room; if there is none, it
  stays shut down and a request for it waits. A slim size pays off once
  devices have booted: in a budget that fits two full devices, with slim
  ones at half that size, three slim devices fit.
- **A device counts by the mode it has, not the one it asked for.** A
  `slim` request on a runtime that cannot be slimmed gets a full device. A
  slim device whose slimming fails comes up full. Either one counts at the
  full size from then on, and keeps its lease. One exception: when Simlock
  reboots a leased slim device to recover it, the device comes back full
  but still counts at the slim size until it is next prepared.
- **Over the limit.** Restarting with larger sizes than the devices were
  admitted under can put the use above the limit. `simlock status` then
  shows the RAM budget `(over limit)`. Until a device is deleted, no new
  device is created, in either mode, and no shut-down slim device boots if
  its slim size is smaller than the full size.
  Releasing a lease does not lower the use, because the device still exists;
  idle devices are still handed out.
- **Raise the limits with the slim size.** The device and running limits
  still apply. A smaller slim size gives you more devices only where RAM is
  what stops full ones; with the default limits (half the CPU count for
  iOS) the device limit is often reached first. Raise
  `limits.ios.maxDevices`, `limits.ios.maxRunning` and `limits.maxRunning`
  together with it.

`simlock status` shows the budget's limit and what is in use, and the use
always equals the sizes of the devices it lists, each by its mode.

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

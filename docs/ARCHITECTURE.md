# Architecture

## Topology

```
agent ──spawns──> pitlane CLI ──┐
                                ├─ shared daemon client ──unix socket──> pitlane daemon
MCP client ──spawns──> stdio MCP ┘                                      │
                                                                     ┌───┼─────────────┐
                                                                     │ core (platform-│
                                                                     │ agnostic)      │
                                                                     │ lease table ·  │
                                                                     │ wait queue ·   │
                                                                     │ registry ·     │
                                                                     │ capacity ·     │
                                                                     │ state machine ·│
                                                                     │ reaper · event │
                                                                     │ bus · warm-pool│
                                                                     │ policy         │
                                                                     └─┬─────────┬────┘
                                                                       │ driver  │ driver
                                                                       ▼ interface ▼ interface
                                                                  iOS driver   Android driver
                                                                  (simctl)     (avdmanager/
                                                                                emulator/adb)
```

- **CLI and stdio MCP server**: sibling thin frontends over the shared daemon
  client and unix socket. The core never knows which frontend made a request.
  The CLI is the full operator interface; the MCP server intentionally limits
  its tool surface to leasing and releasing for an agent session.
- **CLI**: in the default *held* mode it acquires a lease, prints one JSON
  result line on stdout, then stays alive holding the daemon connection; the
  connection is the lease heartbeat. Progress streams as JSON lines on stderr.
- **stdio MCP server**: its process owns one agent session and exposes MCP over
  stdin/stdout. A lease is held by that process's daemon connection until the
  session explicitly releases it or the MCP transport disconnects, at which
  point the connection closes and releases the lease. Like the CLI, it relays
  the daemon's progress pushes for the in-flight `lease_simulator` request —
  as MCP `notifications/progress` instead of stderr JSON lines, and only when
  the client supplied a progress token. Unlike the CLI, this process outlives
  any single daemon connection: `McpSession` does not cache a dead connection.
  `DaemonConnection#onClose` (`src/daemon-client/protocol.ts`) tells the
  session the moment its connection dies — from a graceful `daemon stop`, a
  crash, or `kill -9` — and the next tool call reconnects lazily, auto-starting
  the daemon exactly as the CLI does. A held lease never survives its
  connection dying (the daemon releases it on graceful close, and
  `StartupConverger` sweeps any orphaned lease from an ungraceful death at its
  own startup — see "Lease subsystem boundaries and wiring" above), so the
  session never asks the daemon whether its old lease survived; it clears
  `#ownedLease` and fires `onLeaseLost` (reason
  `daemon-connection-lost`) so the agent hears the fact instead of silently
  reacquiring a device. A dead connection surfaces as typed
  `DAEMON_CONNECTION_LOST` (mid-request) or `DAEMON_UNAVAILABLE` (a failed
  reconnect), not the opaque `INTERNAL`; only idempotent, read-only requests
  (`catalog.get`) retry once, never `lease.request`.
- **Daemon**: owns all state, serializes all decisions. Started on demand,
  reachable over a unix socket.

## Core vs. drivers

The core is platform-agnostic and written once: lease table, fair wait queue,
managed-device registry, device-limit and RAM capacity accounting (RAM is the
binding constraint for Android emulators), the device state machine, the
cleanup reaper, the event bus, and warm-pool *policy*.

Platform mechanisms live behind a narrow driver interface:

```
resolveSpec(request) -> concrete device spec | "runtime missing"
provision(spec)      -> device
makeReady(device)    -> ready device          // boot + readiness probe
reclaim(device)      -> ready | shutdown      // fresh-state strategy lives here
shutdown(device)
destroy(device)
estimate(op)         -> ETA for progress events
listManaged()        -> Pitlane-prefixed device/process reality for doctor
```

The litmus test for the boundary: adding a third driver (e.g. physical
devices) must require **no core changes**. If it does, the interface leaked.

## Running capacity

Managed-device limits govern provisioning, while running limits govern any
operation that starts a device. The core accounts `ready`, `leased`, and
`reclaiming` devices as running. A serialized, platform-agnostic
reservation covers provisioning and boots from `shutdown` until the registry
commits the resulting running or non-running state. Global and platform limits
are checked atomically; no driver-specific runtime details participate in this
decision.

At startup, `StartupConverger` first releases every persisted `held` lease
(reason `orphaned`) through the normal release path — a held lease's liveness
is its daemon connection, so it cannot have a live holder across a restart,
and this runs before timers are restored so an orphaned lease's timer is
never re-armed. It then restores persisted TTL timers for the remaining
(`detached`) leases, whose liveness is the TTL rather than a connection,
recovers unleased interrupted reclaims through the warm-pool recovery port,
and finally deterministically shuts down excess unleased, unclaimed `ready`
registry devices through `CleanupActionExecutor`. Running this release step
before timer restoration and capacity convergence means the devices it frees
are visible to both. Leased devices that survive the orphan sweep are never
touched, so a lowered limit may remain visibly over-limit until leases
naturally release.

## Device state machine

One shared lifecycle for both platforms; drivers map onto it, never extend it:

```
provisioning → ready → leased → reclaiming → ready/shutdown → deleted
```

All transitions go through the core. `pitlane status` reads identically for
iOS and Android because of this.

A warm device is derived inventory, not a state: any registry-managed,
unleased `ready` device is warm. Release always purges while the device is
`reclaiming`; it returns to `ready` when capacity permits, otherwise it is
shut down. Active demand may evict deterministic LRU warm inventory before
starting requested work, without bypassing the FIFO head.

## Fresh-state strategy (benchmarked 2026-07)

Measured on an Apple Silicon / 32 GB machine, iOS 26.5, Android emulator 36.1.9:

| Platform | Strategy | Time to ready |
|---|---|---|
| iOS | create / clone / erase (prep step) | < 1s each |
| iOS | boot + `bootstatus` wait | ~30s, dominates everything |
| Android | cold create or `-wipe-data` boot | ~30s |
| Android | quickboot snapshot restore | **~3.7s** |

Conclusions baked into the drivers:

- **iOS `reclaim` = shutdown + `simctl erase`.** All prep strategies are
  sub-second and tied; erase is the simplest to operate (no golden-device
  bookkeeping). Boot time is a fixed ~30s floor — only a warm pool of
  pre-booted devices can beat it.
- **Android `reclaim` = restore an explicit immutable clean-baseline snapshot**,
  with `-wipe-data` as the fallback. The first clean boot captures and validates
  a named baseline, then restarts from it with automatic snapshot saving
  disabled before the first grant. Its compatibility tag is captured from the
  post-boot AVD configuration because the emulator normalizes `config.ini`
  during first boot. Snapshots are ~1.3 GB each and
  invalidate *silently* on AVD-config / system-image / emulator-version
  changes, so the driver tags the baseline with a config hash and rebuilds it
  before reuse after invalidation.
- **Readiness probes**: iOS `simctl bootstatus` (variance observed up to
  ~30% — use generous timeouts, not a hard SLA). Android:
  `sys.boot_completed == 1` AND (`init.svc.bootanim == "stopped"` OR unset).

## Leases

- **Held mode (default)**: lease lives as long as its holding frontend's daemon
  connection. For the CLI, that is the CLI process; for MCP, it is the MCP
  server process for that agent session. Connection close = release. Known
  gap: orphaned holders when the agent dies — see
  [known-pitfalls.md](known-pitfalls.md).
- **Detached mode (`--detach`)**: returns a token, daemon enforces a TTL, the
  agent must `pitlane renew` periodically.
- **TTL backstop**: even held leases have a long daemon-side TTL for zombie
  sockets, machine sleep, etc.
- **Heartbeat-driven sliding TTL, capability-gated**: a held lease's backstop
  deadline is set once at grant and never moves unless its holder proves it is
  still alive. The daemon pushes `lease.heartbeat` every
  `lease.heartbeatIntervalMs` to a connection only if it (a) holds at least one
  lease and (b) declared `capabilities: { heartbeat: true }` at `hello`
  (`src/daemon/server.ts`). `IpcDaemonConnection` answers automatically with a
  `lease.heartbeat` request (`src/daemon-client/connection.ts`), so any
  frontend inherits ponging for free just by declaring the capability — no
  frontend-specific pong code. The daemon slides every lease the connection
  holds through `LeaseLifecycle.heartbeat()`, which goes through
  `registry.renewLease()` (not a direct `expiryScheduler.replace()`) so the
  persisted deadline never goes stale and a daemon restart mid-lease restores
  the slid deadline, not the grant-time one. It is a pure sliding window: a
  holder that stops ponging simply reaches its existing backstop deadline and
  expires exactly as before — no missed-pong counter, no extra expiry reason.
  MCP declares the capability because its holder process dies with its agent
  (stdin EOF); the CLI deliberately does not, because a backgrounded `pitlane
  lease` gets reparented on the holder's death (see
  [known-pitfalls.md](known-pitfalls.md)) and would otherwise pong forever,
  turning a bounded leak into an unbounded one.
- One lease per agent in v1; no atomic multi-device acquisition (documented
  deadlock risk if two devices are taken sequentially).

### Lease subsystem boundaries and wiring

The lease subsystem is assembled from focused modules. `LeaseEngine` is the
composition root and compatibility facade: it wires one shared
`SerializedDecision`, `DeviceOperationClaims`, `DriverCatalog`, registry, and
capacity coordinator into these direct transactional call chains:

- `WaitQueue` owns pending demand, FIFO order, request timeouts, and progress;
  `AcquisitionPlanner` makes read-only grant/provision/boot/eviction plans;
  `DeviceProvisioner` and `ManagedDeviceLifecycle` perform the resulting driver
  work and registry transitions.
- `LeaseLifecycle` owns grant, renewal, release commits, and expiry scheduling.
  A release passes its committed result directly to `WarmPoolCoordinator`,
  which performs reclaim and warm-pool disposition.
- `CapacityCoordinator` owns provisioning and running reservations while pure
  capacity functions calculate limits. `DeviceOperationClaims` excludes
  overlapping boot, eviction, cleanup, and nuke operations per device.
- `CleanupReaper` evaluates pure rules and directly calls
  `CleanupActionExecutor`; the executor revalidates registry ownership,
  lease/state safety, and delegates the driver operation to
  `ManagedDeviceLifecycle`.
- `StartupConverger` runs orphaned held-lease release, timer restoration,
  interrupted-reclaim recovery, and running-capacity convergence in that
  order. `NukeService` coordinates lease release, pending-request
  cancellation, and registry-scoped reset operations.

The serialized decision gate protects only short read-decide-commit sections.
Driver work remains outside it. Component boundaries use direct calls for
transactions; capacity-changing components notify the FIFO acquisition
coordinator directly. The event bus remains only for post-commit facts and
observers.

The daemon consumes role-specific lease, capacity, queue, cleanup, doctor, and
nuke interfaces rather than duplicating core decisions in the CLI or server.

## Cleanup: many rules, one reaper

Cleanup **rules** are pure decision logic: given a read-only registry view
(device states, last-lease time, disk/RAM stats), they *propose* actions.
A single **reconciliation loop** collects proposals from all registered rules,
dedupes and orders them, and filters obvious unsafe targets. It calls
`CleanupActionExecutor` directly; that executor independently revalidates
registry ownership, lease/state safety, and claims before delegating to the
shared managed-device lifecycle.

v1 rules — the tiered cleanup:

1. idle > T1 → `shutdown` (reclaim RAM)
2. idle > T2 → `destroy` (reclaim disk); under disk pressure (free space
   below `diskPressure.freeBytesThreshold`) `idle-destroy` uses T1 instead of
   T2, so a full disk shortens the wait to reclaim it — the rule reads
   `diskFreeBytes` off the view itself rather than depending on the
   `disk.pressure-detected` event.

Rules are registered in a static in-code list; adding one is a new file plus
one registration line. `--rule <name>` selects a registered rule by name.
Reaper triggers are observer subscriptions to `lease.released`,
`disk.pressure-detected`, and `daemon.started`, plus a periodic tick. The
reaper itself emits `disk.pressure-detected` (edge-triggered, once per
crossing) as a post-commit fact for observers — never as the mechanism that
drives `idle-destroy`'s own behavior. Every successful action emits its rule
and reason in `cleanup.executed`; `pitlane cleanup --dry-run` previews
proposals.

## Event bus

An in-process, typed event bus carries **past-tense business facts**
(`device.reclaimed`, `lease.expired`). Observers — cleanup triggers,
logging/metrics, `pitlane events --follow` — subscribe to it. Warm-pool
reclaim/disposition, cleanup execution, startup convergence, eviction, and
nuke remain explicit direct component call chains.

The bright line: **events for reactions, direct calls for transactions.** The
lease workflow (request → queue → provision → ready → grant) is an explicit
call chain that *emits* events at each transition but never *waits* on them.
Events are emitted post-commit only; handler failures are isolated from
emitters. See [EVENTS.md](EVENTS.md) and
[agent-rules/events.md](agent-rules/events.md).

## External APIs behind interfaces (ports)

Every external API the app touches gets its own type/interface (a *port*),
and application code depends only on that interface — never on the underlying
API directly. This applies to the filesystem, process execution (shelling out
to `simctl`/`adb`/`emulator`), the clock/timers, sockets/IPC, and system
stats (CPU/RAM/disk):

```
Filesystem   — read/write/delete/stat/disk-free
ProcessRunner — spawn/exec/kill, capture stdout/stderr
Clock        — now(), timers (no direct Date/setTimeout in logic)
SystemStats  — cpu count, total/free RAM, disk free
IpcConnector / IpcListenerFactory — connect to and host daemon IPC endpoints
DaemonLauncher — detached daemon startup with append-only combined logs
Logger       — debug/info/warn/error(message, fields) plus child(module) scoping
```

Real implementations are thin adapters wired up once at daemon startup;
tests get in-memory/fake implementations (virtual filesystem, scripted
process runner, manually-advanced clock). This is what makes the core —
queueing, TTL expiry, cleanup rules, capacity math — testable deterministically
and without touching real simulators. Drivers are tested the same way: a
scripted `ProcessRunner` replays recorded `simctl`/`adb` output.

Rule of thumb: if a module imports `fs`, `child_process`, or reads
`Date.now()` directly, it's a bug — depend on the port instead
(see [agent-rules/architecture.md](agent-rules/architecture.md)).

The daemon keeps IPC lifecycle separate from request handling. `DaemonEndpointHost`
claims an endpoint, verifies live peers, removes confirmed stale entries, and owns
listener shutdown. `DaemonServer` only accepts abstract IPC connections and routes
protocol requests to the role-specific `LeaseCommands`, `QueueControl`, and
`CapacityReader` interfaces. On the client, `IpcDaemonConnection` owns framing and
request multiplexing, `IpcDaemonConnector` performs the hello handshake, and
`DaemonStartupCoordinator` uses `Clock` plus `DaemonLauncher` to retry a missing
or refused daemon. This keeps transport, detached-process logging, and startup
policies replaceable without introducing an ambient dependency container.

### Startup: claim first, converge after

Reachability does not depend on startup recovery work. `DaemonServer#start`
claims the socket (`DaemonEndpointHost#start`) before running `startDaemon`'s
`converge` callback — `doctor.reconcile()` followed by
`leaseEngine.convergeRunningCapacity()`, the two calls that shell out per
driver/device and, since running-capacity convergence releases orphaned held
leases and awaits the resulting device reclaim, can take tens of seconds. Two
consequences follow from claiming first:

- A second daemon racing to start now discovers `DaemonAlreadyRunningError`
  from the claim itself, before it does any device work — not after, as when
  convergence ran first.
- `hello` and `status.get` answer immediately, `status.get` reporting
  `health: "starting"` while convergence is in flight and `"running"` once it
  resolves. Every other request type parks on the same readiness promise
  `#awaitReady` awaits, and proceeds normally once convergence completes; no
  request can observe half-converged state, and in particular no lease is
  granted before convergence finishes. A slow startup becomes a slow response
  instead of `DaemonStartupCoordinator`'s client-side timeout firing a false
  failure for a daemon that was starting normally.

If convergence itself throws, `start()` stops the daemon (closing the
listener and any connections that raced in during convergence) rather than
leaving it accepting connections it can never serve; parked requests reject
with `DAEMON_STARTUP_FAILED` instead of hanging. Moving the underlying device
reclaim off the startup path entirely — the remaining source of startup
latency — is a deliberately separate, more invasive follow-up.

Operational logging is a separate concern from the event bus: `pitlane events`
carries business facts (lease granted, device cleaned up, …) in an in-memory
ring buffer that resets on restart, while the `Logger` port writes durable,
structured JSON lines — one per record — for startup, socket claim/recovery,
driver discovery, connection lifecycle, shutdown, and unexpected/handled
errors. `startDaemon` builds the production `Logger` (`JsonLinesLogger` over a
`NodeFileLogSink`) from `config.log` right after config loads, then hands
module-scoped children (`logger.child("server")`, `.child("connection-host")`,
`.child("driver-discovery")`) to each component so every line is attributable.
The sink tracks bytes written and rotates `daemon.log` to `daemon.log.1`
(replacing any previous generation) once `config.log.rotateBytes` is exceeded,
so growth is bounded and `pitlane daemon logs` reads the rotated generation
before the current file. The one exception is the fatal top-level handler: it
cannot depend on `config.log` having loaded successfully, so it builds its own
logger straight from the default log path at a fixed level, falling back to
`console.error` only if that itself fails.

## Device requests

Required to identify a device: **platform + device model + OS version**.
OS defaults to the newest runtime already installed on the machine. If the
requested runtime / system image is not installed, the lease fails with a
clear error unless `--allow-download` is passed (downloads are multi-GB and
must never be triggered implicitly).

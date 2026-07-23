# Architecture

## Topology

```
agent ──spawns──> pitlane CLI ──unix socket──> pitlane daemon
                                                   │
                                     ┌─────────────┼─────────────┐
                                     │        core (platform-    │
                                     │        agnostic)          │
                                     │  lease table · wait queue │
                                     │  registry · capacity      │
                                     │  state machine · reaper   │
                                     │  event bus · warm-pool    │
                                     │  policy                   │
                                     └──────┬───────────┬────────┘
                                            │  driver   │  driver
                                            ▼ interface ▼ interface
                                       iOS driver   Android driver
                                       (simctl)     (avdmanager/
                                                     emulator/adb)
```

- **CLI**: thin client. In the default *held* mode it acquires a lease, prints
  one JSON result line on stdout, then stays alive holding the daemon
  connection; the connection is the lease heartbeat. Progress streams as JSON
  lines on stderr.
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

At startup, `StartupConverger` restores persisted lease TTL timers, recovers
unleased interrupted reclaims through the warm-pool recovery port, then
deterministically shuts down excess unleased, unclaimed `ready` registry
devices through `CleanupActionExecutor`. Leased devices are never touched, so
a lowered limit may remain visibly over-limit until leases naturally release.

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

- **Held mode (default)**: lease lives as long as the CLI process; connection
  close = release. Known gap: orphaned holders when the agent dies — see
  [known-pitfalls.md](known-pitfalls.md).
- **Detached mode (`--detach`)**: returns a token, daemon enforces a TTL, the
  agent must `pitlane renew` periodically.
- **TTL backstop**: even held leases have a long daemon-side TTL for zombie
  sockets, machine sleep, etc.
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
- `StartupConverger` runs timer restoration, interrupted-reclaim recovery, and
  running-capacity convergence in that order. `NukeService` coordinates lease
  release, pending-request cancellation, and registry-scoped reset operations.

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
2. idle > T2 → `destroy` (reclaim disk)
3. unreferenced runtime / system image > T3 (very long, or explicit command
   only) → GC

Runtime GC is explicit-only in v1 (`cleanup --rule runtime-gc`). iOS runtimes
are Xcode-managed and are never deleted by Pitlane.

Rules are registered in a static in-code list; adding one is a new file plus
one registration line. Reaper triggers are observer subscriptions to
`lease.released`, `disk.pressure-detected`, and `daemon.started`, plus a
periodic tick. Every successful action emits its rule and reason in
`cleanup.executed`; `pitlane cleanup --dry-run` previews proposals.

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

## Device requests

Required to identify a device: **platform + device model + OS version**.
OS defaults to the newest runtime already installed on the machine. If the
requested runtime / system image is not installed, the lease fails with a
clear error unless `--allow-download` is passed (downloads are multi-GB and
must never be triggered implicitly).

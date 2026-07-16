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
managed-device registry, capacity accounting (CPU **and** RAM — RAM is the
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

## Device state machine

One shared lifecycle for both platforms; drivers map onto it, never extend it:

```
provisioning → ready → leased → reclaiming → warm/shutdown → deleted
```

All transitions go through the core. `pitlane status` reads identically for
iOS and Android because of this.

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
- **Android `reclaim` = quickboot snapshot restore**, with `-wipe-data` as the
  fallback when a lease needs a truly clean device. Snapshots are ~1.3 GB each
  and invalidate *silently* on AVD-config / system-image / emulator-version
  changes, so the driver tags snapshots with a config hash and detects
  fallback-to-cold-boot.
- **Readiness probes**: iOS `simctl bootstatus` (variance observed up to
  ~30% — use generous timeouts, not a hard SLA). Android:
  `sys.boot_completed == 1` AND (`init.svc.bootanim == "stopped"` OR unset —
  the property is never set under `-no-boot-anim`).

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

## Cleanup: many rules, one reaper

Cleanup **rules** are pure decision logic: given a read-only registry view
(device states, last-lease time, disk/RAM stats), they *propose* actions.
A single **reconciliation loop** collects proposals from all registered rules,
dedupes and orders them, enforces the invariants (never touch a leased device,
never touch anything outside the registry, honor warm-pool minimums), and
executes via the same driver verbs the lease path uses.

v1 rules — the tiered cleanup:

1. idle > T1 → `shutdown` (reclaim RAM)
2. idle > T2 → `destroy` (reclaim disk)
3. unreferenced runtime / system image > T3 (very long, or explicit command
   only) → GC

Runtime GC is explicit-only in v1 (`cleanup --rule runtime-gc`). iOS runtimes
are Xcode-managed and are never deleted by Pitlane.

Rules are registered in a static in-code list; adding one is a new file plus
one registration line. Triggers are event-bus subscriptions
(`device.released`, `disk.pressure-detected`, `daemon.started`) plus a
periodic tick. Every executed action is logged with the proposing rule and
reason; `pitlane cleanup --dry-run` previews.

## Event bus

An in-process, typed event bus carries **past-tense business facts**
(`device.released`, `lease.expired`). Observers — cleanup triggers, warm-pool
policy, logging/metrics, `pitlane events --follow` — subscribe to it.

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

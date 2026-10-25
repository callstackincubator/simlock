# Startup and stop

Modules: [daemon](../../../src/daemon/AGENTS.md), [leasing](../../../src/leasing/AGENTS.md), [core](../../../src/core/AGENTS.md).
Entry: `src/daemon/main.ts` `startDaemon` → `DaemonServer.start` (`src/daemon/server.ts`).

## Both modes, before the branch

1. `loadConfig` reads `config.json`; its warnings are logged once the logger exists.
2. `Logger` → `daemon.log`. At `log.level: debug` the `ProcessRunner` is wrapped.
3. Host info read once (`sw_vers` on macOS); bounded, never throws.
4. `EventBus` → the event history is created (`createEventHistory`). It touches no file yet.
   `refuseWhenDaemonAnswers` (`src/daemon/main.ts:241`) first connects to the socket: a daemon
   that answers makes this one fail with `DaemonAlreadyRunningError`, before any `state.db` is opened.
   `openStateDatabase` then opens the role's `state.db` (both roles) in this order, each failure
   being the daemon's start error: an old file of the role's former state refuses, then
   `node:sqlite` missing, the open and its pragmas, `quick_check`, and in one `BEGIN IMMEDIATE`
   transaction each owner's version (a newer one, or a migration that throws, refuses).
   `createAuth` then builds the token store and the admin secret (hash in memory), once, for both modes.
5. Started with `--gateway` (role `gateway`, data directory `<root>/gateway`) → the gateway section. Otherwise go on.

## Worker: build (before the claim)

6. `Registry.load` — the `registry` and device-data tables of `state.db`.
7. Instance identity — `loadInstanceId`, `instance.json`. Written once per home,
   never regenerated.
8. Root validation — `discoverDrivers`: each driver checks its owned root against
   the instance id. A refused root (`OwnedRootError`), or on Android an adb server
   it cannot start, drops that platform as a `DriverRejection`; a missing SDK drops
   it silently; any other error fails the start. iOS only on macOS. The Android
   driver starts its adb server and reattaches running emulators here.
9. Host facts read in the background; host load sampler built.
10. `ComponentInstaller`, `createCore`, the optional-module host (`createModuleHost`; it loads each enabled module's worker half, agent-device's supervisor among them), `createLeasing`,
    `core.connect(leasing.corePorts)`, `CleanupReaper`, `Nuke`, `GatewayUplink` when
    `gateway.url` and `gateway.token` are set, `DaemonServer`.

## Worker: claim and converge (`DaemonServer.start`)

11. Claim the socket — `DaemonEndpointHost.start`. A live daemon →
    `DaemonAlreadyRunningError`; the start rejects, the entry logs `Daemon already running` and exits 0. A stale socket file is
    removed.
12. Host load sampling starts.
13. `admin.token` written (0600, atomic).
14. Converge starts. Health `starting`. From here `hello` and `status.get` answer;
    every other request parks.
15. `onSocketClaimed`, nothing awaited: the event history starts (opens `history.db`, sets a
    damaged one aside, migrates the projections, writes the ring, prunes, rebuilds a projection whose
    check failed; a newer stored version or a failed migration stops the daemon, exit 1); agent-device starts; the uplink dials once
    the first host load reading is in; HTTP starts when `http.enabled`.

Converge (`src/daemon/main.ts` `convergeStartup`), one step after another. Once a stop
reaches its settle step, the steps after the read are skipped. Before step 16 it
removes the `.<name>.<pid>.<uuid>.tmp` files and `.<root>.<pid>.<id>.staging` directories of dead writers beside each device root and in
the data directory (`sweepWriteLeftovers`).

16. Settle open requests — `leasing.settleRequests`: every `open` request fails
    `INTERNAL`; `lease.rejected` with reason `daemon-restarted`.
17. Startup read — `core.readStartup`: one `listManaged` per driver, side by side,
    each bounded by `STARTUP_READ_LIMIT_MS` (60 s, not a config key). A throw or a
    timeout makes that platform unreadable. It never fails startup.
18. Doctor reconcile — `core.doctor.reconcile({ read })` on that read; no second listing.
19. Lease reconciler — `LeaseReconciler.run(read)`, table below. Leases on
    physical devices are skipped.
20. Restore TTL timers for the leases left. One whose deadline passed expires
    through the ordinary expiry path. The physical watcher notes enrolled devices
    left in `reclaiming`.
21. Core converge — `StartupConverger.converge(read)`, readable platforms only,
    unleased and unclaimed virtual devices only:
    1. Quarantine re-arm: retry timers of `quarantined` devices.
    2. Interrupted reclaims (`reclaiming`): with `deferredReclaimLeaseId` → full
       reclaim in the background under a `reclaim` claim; else shut down,
       `device.shutdown` (initiator `startup-interrupted-reclaim`).
    3. Spent deletes: `shutdown` devices that may not be granted again are deleted
       inline. A failed delete is logged; the device stays `shutdown`.
    4. Warm pool and capacity observer start. The pool closes the lease rows of its learned-kind
       record whose lease the registry no longer holds, and its first pass boots the recorded kinds.
22. `queue.changed` with the first depth. Converge done → health `running`.

Arm (skipped when a stop already ran):

23. Owner-routed push subscription.
24. `daemon.started` (redacted config), then one event per driver rejection.
25. Health monitor and physical device watcher start.

Converge throws → health `failed`; parked requests get `DAEMON_STARTUP_FAILED`;
stop `convergence-failed`; the start rejects.
HTTP fails to bind → the converge hook waits for the listener before step 22's `running`, so health `failed`, no `daemon.started`, stop `http-start-failed`; the start rejects.

### Lease reconciler outcomes (ADR 0019)

| Device in the read | Lease | Device |
|---|---|---|
| `running` | kept; timer restored | unchanged |
| `stopped` or `transitioning` | ended | background reclaim |
| absent, platform readable | ended | marked missing in the same write (`device.deleted`, initiator `doctor`); no reclaim |
| platform unreadable | ended | stays `reclaiming` with `deferredReclaimLeaseId`; no reclaim, no claim |

An ended lease emits `lease.released` reason `device-lost`, or `lease.expired`
when its deadline passed while no daemon ran. A later start that reads the
platform runs the deferred reclaim (step 21.2).

## Gateway

1. Instance identity — `instance.json`.
2. `FleetLeaseIndex`, routing policy,
   `GatewayService` (drained workers in `state.db`), `FleetLeaseCoordinator`, `DaemonServer`
   with `GatewayDispatcher`. No registry, drivers, reaper or health monitor.
3. `DaemonServer.start`: claim → host load → `admin.token` → converge starts →
   the event history starts → HTTP starts (uplink listener on the same server).
4. Converge — `GatewayService.start`, then `FleetLeaseCoordinator.start`. A worker
   that dials before it ends is refused and redials.
5. `daemon.started`. The gateway's dispatcher never parks a request.

## Stop

`DaemonServer.stop(reason)` — one stop per process; a second call gets the same promise.

1. Mark stopping; close the warm pool (`core.closeWarmPool`). New requests get
   `DAEMON_STOPPING`; `daemon.stop` still answers.
2. Stop auxiliary fronts: agent-device edge (cancel its waiting allocates),
   HTTP (after its start settles), the uplink and its redial loop.
3. Log, emit `daemon.stopping`.
4. Unsubscribe pushes; dispose host load, dispatcher, reaper, then wait for every
   cleanup run in flight (scheduled, dry-run or rule-scoped) to end; dispose health
   monitor, physical watcher.
5. Settle — later converge steps are skipped; leasing drains the physical
   watcher and background reclaims; core drains the warm pool.
6. Dispose — core and leasing timers, `ComponentInstaller.close`, agent-device
   stop, every driver's `dispose` (all tried; failures logged), then the event history stops
   (cancels its prune timer, closes `history.db`), so the stop's own events are written.
7. Close connections, remove `admin.token`, release the socket (released even when the removal fails).

A gateway's stop: agent-device edge and HTTP, then `FleetLeaseCoordinator` and
`GatewayService` are disposed, then the event history stops and `state.db` closes.

A stop releases nothing. Leases stay in `state.db` with their deadlines; the
next start re-arms or ends them (steps 19–20).

# Core

Does: device management on a worker — registry, state machine, device verbs, reclaim, quarantine, warm pool, capacity, cleanup, components, baselines, doctor.
Entry: `index.ts` → `createCore(options)`, then `core.connect(ports)` once, before any request.
Uses: auth (config strategies), bus, ports, contract, history (`usage/` only). Never imports: leasing, drivers, daemon, gateway, agent-device.
Imported by: daemon, leasing, cli, http, agent-device, drivers (`Driver`, `ensureOwnedRoot`), gateway (catalog match, `fits`, `createUsageReader`).
Flows: [startup](../../docs/internal/flows/startup.md), [device selection](../../docs/internal/flows/device-selection.md).
See also: [leasing](../leasing/AGENTS.md) (lease flow, when reclaim runs), [warm pool](warm-pool/AGENTS.md), [capacity](capacity/AGENTS.md).

## Files

| File                                                      | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wiring and state**                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `create-core.ts`, `core-ports.ts`                         | `createCore`, `Core`, `CorePorts`; read ports (`CapacityReader`, `WarmPoolReader`, …)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `registry.ts`, `registry-rows.ts`, `registry-schema.ts`   | `Registry`: the one writer of the registry tables of `state.db`; the rows, the `registry` schema owner                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `domain.ts`                                               | Records, specs, `transition`, `fits`, `mayBeGranted`, `sameSpec`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `serialized-decision.ts`, `device-operation-claims.ts`    | The lock; one in-memory claim per device                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `config.ts`, `validation.ts`                              | `loadConfig({ role })`, `loadConfigWithDefaults` (also the module names whose `enabled` came from an `enabledByDefault` default) (the role comes from the daemon, never a config key; a `mode` key is refused; with the optional modules' `ModuleConfigEntry` list: `capabilities.<name>` sections, `enabled` owned here; with the drivers' `DriverConfigEntry` list: each driver's own keys under `ios` and `android`, read back typed by `driverConfig`), defaults, validators, `redactConfig`, `effectiveAllowDownload` |
| `lease-request-store.ts`                                  | Pure lease-request record helpers, shared with leasing                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Device verbs**                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `managed-device-lifecycle.ts`                             | `ManagedDeviceLifecycle`: every driver verb on a registered device                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `device-provisioner.ts`                                   | `DeviceProvisioner`: the one place a device record is created                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `reclaim-coordinator.ts`                                  | `ReclaimCoordinator`: delete a virtual device after its lease, wipe a physical one, interrupted reclaim                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `quarantine-coordinator.ts`                               | `QuarantineCoordinator`: entry, retry on backoff, give up                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `nuke-service.ts`, `nuke.ts`                              | `NukeService` (operator reset); `Nuke` (command facade)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `idle-order.ts`                                           | LRU order and eviction victim choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Background**                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `warm-pool/`, `capacity/`                                 | What stays warm; limits, RAM budget, reservations (own manuals)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `reaper.ts`, `cleanup/`, `cleanup-executor.ts`            | `CleanupReaper`, pure rules, `CleanupExecutor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Startup, health, drivers**                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `startup-read.ts`, `startup-converger.ts`                 | `readStartup`; `StartupConverger`, the device half of startup                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `write-leftovers.ts`                                      | `sweepWriteLeftovers`: removes dead writers' `.tmp` files and the `.staging` dirs of the device roots it is given; logs pid-less legacy ones, never deletes them                                                                                                                                                                                                                                                                                                                                                           |
| `doctor.ts`, `host-facts.ts`                              | `Doctor` findings and fixes (`service-broken` from an injected `serviceCheck`, never drift); `HostFactsReader` for status                                                                                                                                                                                                                                                                                                                                                                                                  |
| `driver.ts`, `driver-catalog.ts`, `screen.ts`, `input.ts` | `Driver`, errors, `DiskSpaceGuard`; `DriverCatalog` (`openScreen`, `openInput`); `ScreenCapture`, frame tags; `DeviceInput`, the input messages and their parser                                                                                                                                                                                                                                                                                                                                                           |
| `catalog-match.ts`                                        | Model name, class and paired runtimes against a catalog entry                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `baselines.ts`, `baselines-schema.ts`                     | `BaselineService`: save, list, remove, `removeAll` (nuke), stale check, `nameSources` (doctor); owner `baselines`. One save or remove at a time                                                                                                                                                                                                                                                                                                                                                                            |
| `component-installer.ts`                                  | `ComponentInstaller`: install, list, remove                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `physical-enrollment.ts`, `physical-presence.ts`          | `device add`/`remove`; every presence read, `latestPresence`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `device-root.ts`, `instance-identity.ts`                  | `ensureOwnedRoot`; `loadInstanceId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `stable-error.ts`, `testing.ts`, `fake-driver.ts`         | `stableError`; test-only wiring, `testConfig(overrides)` (a whole config from the loader's defaults) and `FakeDriver`                                                                                                                                                                                                                                                                                                                                                                                                      |

## Wiring

1. `src/daemon/main.ts` builds `Registry.load`, one `SerializedDecision`, one `ComponentInstaller`,
   `createCore`, then `CleanupReaper`, `Nuke`, `HostFactsReader`. `createCore` builds the rest.
2. `createLeasing` builds `corePorts`; the daemon calls `core.connect`. A port used before that
   throws `CorePortMissingError`. Ports: `leaseMaintenance` (nuke), `leaseExpirer` (doctor), `warmPoolDemand` (demand, mode, `resolve`), `notifyAvailability` (kick the queue); `physicalDeviceReady` is optional, a no-op before `connect`.
3. Lock: `SerializedDecision.run`, shared by core, leasing and the installer. No driver I/O inside.
4. Claims: one per device, memory only. Kinds: `boot`, `eviction`, `cleanup`, `nuke`, `recovery`, `reclaim`, `enrollment`, `grant`; optional `owner`.
5. Every verb: claim + revalidate (lock) → driver (no lock) → revalidate + commit (lock) → release.
6. Commit: one `state.db` transaction that writes the rows whose record changed (and a device's device-data row) → memory → `onCommit` → event; a throw rolls back and leaves memory as it was. A transition
   without the one event its edge calls for throws `RegistryEventError`.

## Device state machine

`transition` in `domain.ts`. Main loop: `provisioning → ready → leased → reclaiming → ready | shutdown → deleted`.

```
virtual   provisioning → ready | quarantined | deleted
          ready        → leased | shutdown
          leased       → reclaiming
          reclaiming   → ready | shutdown | quarantined
          shutdown     → ready | quarantined | deleted
          quarantined  → ready | shutdown | deleted
physical  ready        → leased | absent | deleted
          leased       → reclaiming | absent
          reclaiming   → ready | quarantined | absent
          absent       → reclaiming | ready | deleted        (absentReason: locked, untrusted, not-present)
          quarantined  → ready | deleted
```

Events: → `absent` `device.absence-detected`; `absent` → `reclaiming` `device.returned`; out of
`reclaiming` `device.reclaimed`; → `ready`/`shutdown`/`deleted` `device.ready`/`.shutdown`/`.deleted`.
`markDeviceMissing` writes `deleted` from any state. `deleted` records stay in the file.

## How it works

1. **Lifecycle** — `bootForLease`, `readyProvisionedForLease` keep the `boot` claim for the
   grant; `bootWarm` drops it at `ready`. `shutdown`, `destroy`, `dispose` answer `undefined` for a
   leased, gone or moved device. `recoverLeased` reboots under the lease: no commit, no event.
2. **Provision** — `claimProvision` (lock) → `driver.provision` → `registerDevice` (`provisioning`,
   `device.provisioned`, optional `boot` claim) → ready. Boot failure: destroy, `BootTimeoutError` carrying the driver's message.
3. **Reclaim** — `ReclaimCoordinator.reclaim`, after leasing's lease-end commit. A virtual device (`mayBeGranted` refuses every released one): shutdown → destroy → `deleted`, initiator `lease-end`. A physical device: commit what `driver.reclaim` returns. Failure → quarantine; physical and not present → `absent`. `reclaimReturned` wipes a returned device in the background.
4. **Quarantine** — from a failed purge, a failed spent delete, a failed boot-destroy, or
   `doctor --fix` on a stall. Retry under `reclaim` (claim held: wait one backoff): a virtual device is destroyed, a physical one reclaimed. Out of retries: destroy a virtual device
   (`device.quarantine-abandoned`; failed destroy: `device.quarantine-stranded`, stays), unenrol a
   physical one. Physical not present: wait `health.probeIntervalMs`, not counted. Entry writes
   `quarantineCause` (kind, message cut to 300 characters, or `stalledState`); retries keep it, every exit drops it.
5. **Cleanup** — `CleanupReaper` on `lease.released`, `daemon.started`, `disk.pressure-detected`, a
   tick. `idle-shutdown`: leased once, `ready`, idle past T1, neither warm-targeted nor serving a queued request with the pool enabled. `idle-destroy`:
   `shutdown`, idle (lease end, else `shutdownAt`) past T2, or T1 under pressure. `CleanupExecutor`
   revalidates, acts, emits `cleanup.executed`; a throwing action is logged, the run goes on.
6. **Nuke** — one at a time: close acquisition, settle reclaim and warm pool → release all leases
   `killed` → clear the warm pool's learned kinds → shut down each unleased `ready` virtual device; with delete, destroy each `shutdown` one; a device it cannot reset is logged, the rest go on.
7. **Startup** — `readStartup` (`listManaged` per driver, parallel) → `doctor.reconcile({ read })`
   → leasing's reconcile → `core.converge`: re-arm quarantine → recover interrupted reclaims →
   delete spent devices → start warm pool and `CapacityObserver`. Skips unreadable, leased, claimed.
8. **Doctor** — registry against `listManaged`. `--fix`: mark missing devices `deleted`, expire
   lapsed leases, match `ready`/`shutdown` to the observed run state, destroy legacy devices,
   quarantine stalls (age > estimate × `stalledTransition.thresholdMultiplier`, unclaimed).
9. **Physical** — `PhysicalEnrollment.add` refuses Simlock's own devices, reads `inspectPhysical`,
   writes `ready` with `enrolledApps`, or re-enrols under `enrollment`; `remove` unenrols. Busy: `DeviceBusyError`.
10. **Ownership** — `loadInstanceId` creates `instance.json` once (exclusive create, `0600`). `ensureOwnedRoot`
    stages a root with `.simlock-owned.json` (instance id, platform), mode `0700`; doubt is `OwnedRootError`. With no `uid` (Windows) it checks neither owner nor mode, and a rename refused `EPERM` onto a root now there is a lost race.
11. **Components** — `ComponentInstaller`, the only caller of `installComponent`/`removeComponent`.
    One FIFO per platform; a call for the same component joins. At the front: `stillNeeded` →
    `findComponent` → `DiskSpaceGuard.reserve` (one guard, both platforms) → driver → record (lock) →
    `component.installed`. `effectiveAllowDownload`: `never` refuses, `always` grants, `on-request`
    follows the caller. Remove: own it → no users → platform idle (`dryRun` stops) → mark (lock):
    `claimProvision` throws `ComponentBeingRemovedError` → `removeComponent` → delete record.
12. **Baselines** — `BaselineService` (`core.baselines`), ADR 0061 §4. `save` queues behind any save or remove, then leasing's
    `releaseToSave` ends the lease and `ReclaimCoordinator.retireSaved` calls `driver.saveSource` under the `reclaim` claim: row,
    `baseline.saved`, `destroy`; a driver failure quarantines the device and answers `BASELINE_SAVE_FAILED`. A replace deletes the idle, unclaimed devices of older versions in the gate and keeps leased ones; an older version (row and source) is dropped only when no device record and no provision (`hold`) has it, checked after a save, on every `device.deleted` and at startup (`baseline.removed` reason `replaced`). `remove` refuses a
    baseline a lease uses (`BaselineInUseError`), disposes its idle devices, then deletes sources and rows. `checkStale` runs before
    `list` and `doctor` and after `component.removed`. `nameSources` marks a baseline source no row names `orphan`. `removeAll` (nuke) deletes rows first.

## State and timers

| What                               | Default                     | Key                                                     |
| ---------------------------------- | --------------------------- | ------------------------------------------------------- |
| Idle shutdown (T1), delete (T2)    | 10 min, 60 min              | `idle.shutdownAfterMs`, `idle.deleteAfterMs`            |
| Disk pressure; reaper tick         | below 10 GiB free; 60 s     | `diskPressure.freeBytesThreshold`; none                 |
| Quarantine retries                 | 3, from 30 s, ×2, cap 5 min | `warmPool.quarantine.*`                                 |
| Stall threshold                    | estimate × 3, at least 60 s | `stalledTransition.*`                                   |
| Install budget per call            | 20 min                      | `downloads.timeoutMs`                                   |
| Download policy                    | `on-request`                | `downloads.policy`                                      |
| Removal, startup read per platform | 5 min, 60 s                 | `COMPONENT_REMOVAL_TIMEOUT_MS`, `STARTUP_READ_LIMIT_MS` |
| Host facts max age, tool read      | 60 s, 30 s                  | none                                                    |

`state.db`, owner `registry`: `devices` (a physical device is `physical = 1`, its apps in `device_enrolled_apps`), `leases`, `lease_requests`, `lease_grants` with `lease_grant_environment`, `components` with `component_receipt`. A driver keeps its own `DeviceDataTable` (`driver.ts`) for a virtual device's `driverData`; a physical device has none. A granted request's `grant.device` is read as the device is now.

## Rules

- Only `Registry` writes the `registry` tables, inside `SerializedDecision.run`. Events after the commit.
- Destroy only what the registry holds. One exception: `doctor --purge-orphans`, opt-in.
- Nothing in core acts on a leased device, except `recoverLeased`, under the lease.
- Grant paths select by exact state; `mayBeGranted` keeps a spent `fresh` device out.
- A physical device is never destroyed and never counted against capacity.
- Unreadable is not gone: startup skips a platform it could not list; doctor reports no drift there.
- A part takes the config sections it reads, never the whole `Config`: `CoreConfig` (`createCore`), `DoctorConfig`, `CleanupConfig`. A test builds only that slice, or `testConfig` when it needs a whole config; it never writes a whole `Config` by hand.
- Warm pool and startup never install. Instance id is never regenerated. Core imports no leasing or driver (dependency-cruiser `core-not-leasing`, `core-not-drivers`).

## Known gaps

- **A rollback keeps a stale quarantine cause.** An older daemon keeps `quarantineCause` unknown; re-entry under it shows the old one.
- **One download at a time per platform.** A second missing runtime waits, spending its own `downloads.timeoutMs`. A bounded model with no `--os` asks Xcode for a bare major; pass `--os`.
- **`component remove` sees only this instance.** One worker per user, so this matters for test roots and a second OS user. Another instance's devices, never-used default-set simulators and foreign devices made after the driver's count are not counted.
- **An older Simlock cannot end a physical lease.** It skips `physicalDevices`; `beginRelease` throws `UnknownDeviceError`. Release physical leases before a rollback.
- **Two instances can enrol one device.** Only test roots and a second OS user can run a second instance. Each release uninstalls apps not on its own list. Enrol a device in one instance only.

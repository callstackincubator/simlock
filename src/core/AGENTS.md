# Core

Does: device management on a worker — registry, state machine, device verbs, reclaim, quarantine, warm pool, capacity, cleanup, components, doctor.
Entry: `index.ts` → `createCore(options)`, then `core.connect(ports)` once, before any request.
Uses: bus, ports, contract. Never imports: leasing, drivers, daemon, gateway, agent-device.
Imported by: daemon, leasing, cli, http, agent-device, drivers (`Driver`, `ensureOwnedRoot`), gateway (catalog match, `fits`).
Flows: [startup](../../docs/internal/flows/startup.md), [device selection](../../docs/internal/flows/device-selection.md).
See also: [leasing](../leasing/AGENTS.md) (lease flow, when reclaim runs), [warm pool](warm-pool/AGENTS.md), [capacity](capacity/AGENTS.md).

## Files

| File                                                   | Role                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wiring and state**                                   |                                                                                                                                                                                          |
| `create-core.ts`, `core-ports.ts`                      | `createCore`, `Core`, `CorePorts`; read ports (`CapacityReader`, `WarmPoolReader`, …)                                                                                                    |
| `registry.ts`                                          | `Registry`: the one writer of `state.json`                                                                                                                                               |
| `domain.ts`                                            | Records, specs, `transition`, `fits`, `mayBeGranted`, `sameSpec`                                                                                                                         |
| `serialized-decision.ts`, `device-operation-claims.ts` | The lock; one in-memory claim per device                                                                                                                                                 |
| `config.ts`, `validation.ts`                           | `loadConfig` (with the optional modules' `ModuleConfigEntry` list: `capabilities.<name>` sections, `enabled` owned here), defaults, validators, `redactConfig`, `effectiveAllowDownload` |
| `lease-request-store.ts`                               | Pure lease-request record helpers, shared with leasing                                                                                                                                   |
| **Device verbs**                                       |                                                                                                                                                                                          |
| `managed-device-lifecycle.ts`                          | `ManagedDeviceLifecycle`: every driver verb on a registered device                                                                                                                       |
| `device-provisioner.ts`                                | `DeviceProvisioner`: the one place a device record is created                                                                                                                            |
| `reclaim-coordinator.ts`                               | `ReclaimCoordinator`: wipe after a lease, spent delete, interrupted reclaim                                                                                                              |
| `quarantine-coordinator.ts`                            | `QuarantineCoordinator`: entry, retry on backoff, give up                                                                                                                                |
| `nuke-service.ts`, `nuke.ts`                           | `NukeService` (operator reset); `Nuke` (command facade)                                                                                                                                  |
| `idle-order.ts`                                        | LRU order and eviction victim choice                                                                                                                                                     |
| **Background**                                         |                                                                                                                                                                                          |
| `warm-pool/`, `capacity/`                              | What stays warm; limits, RAM budget, reservations (own manuals)                                                                                                                          |
| `reaper.ts`, `cleanup/`, `cleanup-executor.ts`         | `CleanupReaper`, pure rules, `CleanupExecutor`                                                                                                                                           |
| **Startup, health, drivers**                           |                                                                                                                                                                                          |
| `startup-read.ts`, `startup-converger.ts`              | `readStartup`; `StartupConverger`, the device half of startup                                                                                                                            |
| `doctor.ts`, `host-facts.ts`                           | `Doctor` findings and fixes; `HostFactsReader` for status                                                                                                                                |
| `driver.ts`, `driver-catalog.ts`, `screen.ts`          | `Driver`, errors, `DiskSpaceGuard`; `DriverCatalog`; `ScreenCapture`, frame tags                                                                                                         |
| `catalog-match.ts`                                     | Model name, class and paired runtimes against a catalog entry                                                                                                                            |
| `component-installer.ts`                               | `ComponentInstaller`: install, list, remove                                                                                                                                              |
| `physical-enrollment.ts`, `physical-presence.ts`       | `device add`/`remove`; every presence read, `latestPresence`                                                                                                                             |
| `device-root.ts`, `instance-identity.ts`               | `ensureOwnedRoot`; `loadInstanceId`                                                                                                                                                      |
| `stable-error.ts`, `testing.ts`, `fake-driver.ts`      | `stableError`; test-only wiring and `FakeDriver`                                                                                                                                         |

## Wiring

1. `src/daemon/main.ts` builds `Registry.load`, one `SerializedDecision`, one `ComponentInstaller`,
   `createCore`, then `CleanupReaper`, `Nuke`, `HostFactsReader`. `createCore` builds the rest.
2. `createLeasing` builds `corePorts`; the daemon calls `core.connect`. A port used before that
   throws `CorePortMissingError`. Ports: `leaseMaintenance` (nuke), `leaseExpirer` (doctor),
   `warmPoolDemand` (demand, mode, `resolve`), `notifyAvailability` (kick the queue);
   `physicalDeviceReady` is optional, a no-op before `connect`.
3. Lock: `SerializedDecision.run`, shared by core, leasing and the installer. No driver I/O inside.
4. Claims: one per device, memory only. Kinds: `boot`, `eviction`, `cleanup`, `nuke`, `recovery`,
   `reclaim`, `enrollment`, `grant`; optional `owner`.
5. Every verb: claim + revalidate (lock) → driver (no lock) → revalidate + commit (lock) → release.
6. Commit: whole `state.json` via `writeFileAtomic` → memory → `onCommit` → event. A transition
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
   `device.provisioned`, optional `boot` claim) → ready. Boot failure: destroy, `BootTimeoutError`.
3. **Reclaim** — `ReclaimCoordinator.reclaim`, after leasing's lease-end commit. Spent `fresh`:
   shutdown → destroy → `deleted`. Else commit what `driver.reclaim` returns. Failure → quarantine;
   physical and not present → `absent`. `reclaimReturned` wipes a returned device in the background.
4. **Quarantine** — from a failed purge, a failed spent delete, or `doctor --fix` on a stall. Retry
   under `reclaim` (claim held: wait one backoff). Out of retries: destroy a virtual device
   (`device.quarantine-abandoned`; failed destroy: `device.quarantine-stranded`, stays), unenrol a
   physical one. Physical not present: wait `health.probeIntervalMs`, not counted.
5. **Cleanup** — `CleanupReaper` on `lease.released`, `daemon.started`, `disk.pressure-detected`, a
   tick. `idle-shutdown`: leased once, `ready`, idle past T1, not warm-targeted. `idle-destroy`:
   `shutdown`, idle (lease end, else `shutdownAt`) past T2, or T1 under disk pressure.
   `CleanupExecutor` revalidates, acts under `cleanup`, emits `cleanup.executed`.
6. **Nuke** — one at a time: close acquisition, settle reclaim and warm pool → release all leases
   `killed` → shut down each unleased `ready` virtual device; with delete, destroy each `shutdown` one.
7. **Startup** — `readStartup` (`listManaged` per driver, parallel) → `doctor.reconcile({ read })`
   → leasing's reconcile → `core.converge`: re-arm quarantine → recover interrupted reclaims →
   delete spent devices → start warm pool and `CapacityObserver`. Skips unreadable, leased, claimed.
8. **Doctor** — registry against `listManaged`. `--fix`: mark missing devices `deleted`, expire
   lapsed leases, match `ready`/`shutdown` to the observed run state, destroy legacy devices,
   quarantine stalls (age > estimate × `stalledTransition.thresholdMultiplier`, unclaimed).
9. **Physical** — `PhysicalEnrollment.add` refuses Simlock's own devices, reads `inspectPhysical`,
   writes `ready` with `enrolledApps`, or re-enrols under `enrollment`; `remove` unenrols. Busy: `DeviceBusyError`.
10. **Ownership** — `loadInstanceId` creates `instance.json` once (exclusive create). `ensureOwnedRoot`
    stages a root with `.simlock-owned.json` (instance id, platform), mode `0700`; doubt is `OwnedRootError`.
11. **Components** — `ComponentInstaller`, the only caller of `installComponent`/`removeComponent`.
    One FIFO per platform; a call for the same component joins. At the front: `stillNeeded` →
    `findComponent` → `DiskSpaceGuard.reserve` (one guard, both platforms) → driver → record (lock) →
    `component.installed`. `effectiveAllowDownload`: `never` refuses, `always` grants, `on-request`
    follows the caller. Remove: own it → no users → platform idle (`dryRun` stops) → mark (lock):
    `claimProvision` throws `ComponentBeingRemovedError` → `removeComponent` → delete record.

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

`state.json`: `devices`, `physicalDevices`, `leases`, `leaseRequests`, `components`; unknown keys kept.

## Rules

- Only `Registry` writes `state.json`, inside `SerializedDecision.run`, mode `0600`. Events after the commit.
- Destroy only what the registry holds. One exception: `doctor --purge-orphans`, opt-in.
- Nothing in core acts on a leased device, except `recoverLeased`, under the lease.
- Grant paths select by exact state; `mayBeGranted` keeps a spent `fresh` device out.
- A physical device is never destroyed and never counted against capacity.
- Unreadable is not gone: startup skips a platform it could not list; doctor reports no drift there.
- Warm pool and startup never install. Instance id is never regenerated.
- Core imports no leasing or driver (dependency-cruiser `core-not-leasing`, `core-not-drivers`).

## Known gaps

- **One download at a time per platform.** A second missing runtime waits, spending its own
  `downloads.timeoutMs`. A bounded model with no `--os` asks Xcode for a bare major; pass `--os`.
- **`component remove` sees only this instance.** Another instance's devices, never-used default-set
  simulators and foreign devices made after the driver's count are not counted.
- **An older Simlock cannot end a physical lease.** It skips `physicalDevices`; `beginRelease`
  throws `UnknownDeviceError`. Release physical leases before a rollback.
- **Two instances can enrol one device.** Each release uninstalls apps not on its own list.
  Enrol a device in one instance only.

# Core

Does: device management on a worker — registry, state machine, device verbs, reclaim, quarantine, warm pool, capacity, cleanup, components, baselines, doctor.
Flows: [startup](../../docs/internal/flows/startup.md), [device selection](../../docs/internal/flows/device-selection.md), [leasing](../leasing/AGENTS.md) (lease flow, when reclaim runs), [warm pool](warm-pool/AGENTS.md), [capacity](capacity/AGENTS.md).

## Rules

Wiring:

- `core.connect(ports)` runs once, before any request; a port used before it throws. `physicalDeviceReady` is optional and a no-op before `connect`.
- Core never imports daemon or gateway, and only `usage/` imports history. Leasing and drivers are kept out by the dependency rules `core-not-leasing` and `core-not-drivers`.
- A part takes the config sections it reads, never the whole `Config`: `CoreConfig` (`createCore`), `DoctorConfig`, `CleanupConfig`. A test builds only that slice, or `testConfig` when it needs a whole config; it never writes a whole `Config` by hand.
- The role comes from the daemon, never from a config key; a `mode` key is refused.

Lock, claims and commits:

- One `SerializedDecision`, shared by core, leasing and the installer. No driver I/O inside it.
- One claim per device, in memory only.
- Every verb: claim and revalidate (lock) → driver (no lock) → revalidate and commit (lock) → release.
- Only `Registry` writes the `registry` tables, inside `SerializedDecision.run`. A commit is one `state.db` transaction, then memory, then `onCommit`, then the event. A throw rolls back and leaves memory as it was.
- A transition without the one event its edge calls for throws `RegistryEventError`.
- A virtual device record is created only by `DeviceProvisioner`. Every driver verb on a registered device goes through `ManagedDeviceLifecycle`.
- A driver keeps its own `DeviceDataTable` (`driver.ts`) for a virtual device's `driverData`; a physical device has none.
- A granted request's `grant.device` is read as the device is now.

Devices:

- The state machine is `transition` in `domain.ts`. `markDeviceMissing` writes `deleted` from any state of a device with no lease. A `deleted` record stays in `state.db` and `status.get` for `devices.deletedRetentionMs`, counted from `deletedAt`, then `snapshot` stops listing it and the next commit drops it, with no event; a row already `deleted` at the first start after the upgrade gets that start's time.
- Destroy only what the registry holds. One exception: `doctor --purge-orphans`, opt-in.
- Nothing in core acts on a leased device, except `recoverLeased`, under the lease: it reboots with no commit and no event.
- Grant paths select by exact state. `mayBeGranted` refuses every virtual device that has ended a lease, whatever its `leaseIdentity` (ADR 0061 §2).
- A physical device is never destroyed and never counted against capacity.
- `PhysicalAutoEnrollment` (`devices.autoEnroll`, ADR 0073) enrols through `PhysicalEnrollment.add(..., { initiator: "auto" })`, which leaves an ID that has a live record inside the lock alone. It holds a phone out once a run saw it with a live record, it enrolled it, or a record of it was deleted after the attachment began; the hold-out is memory only and ends after `health.stableObservations` runs without the ID on USB. A run whose list throws counts as none of them.
- `bootForLease` and `readyProvisionedForLease` keep the `boot` claim for the grant; `bootWarm` drops it at `ready`.
- `rebootForLease` shuts a `ready` device down and prepares it again with a lease's `except` list under that claim. The record stays `ready` (one `recordRebootedDevice` write, no event); on a failure it commits `ready → shutdown` first.
- `devices.except_categories` holds the list a lease kept running, written in the grant commit (`createLease`).
- `shutdown`, `destroy` and `dispose` answer `undefined` for a leased, gone or moved device. That is not an error.
- Unreadable is not gone: startup skips a platform it could not list; doctor reports no drift there.
- Warm pool and startup never install. Instance id is never regenerated.
- `sweepWriteLeftovers` logs a pid-less legacy leftover and never deletes it.
- Doctor's `service-broken` comes from an injected `serviceCheck`, never from drift.

Reclaim and quarantine:

- Reclaim runs after leasing's lease-end commit. A virtual device: shutdown → destroy → `deleted`. A physical device: commit what `driver.reclaim` returns.
- A failed reclaim quarantines. A physical device that is not present goes `absent` instead, and its reclaim runs again when it is back.
- Quarantine retries run under the `reclaim` claim: a virtual device is destroyed, a physical one reclaimed. A physical device not present waits `health.probeIntervalMs`, and that try is not counted.
- Out of retries, a virtual device is destroyed and a physical one unenrolled (`device.quarantine-abandoned`). A destroy that fails leaves the device quarantined, with its capacity slot and no further retry (`device.quarantine-stranded`).
- `quarantineCause` is written at entry; retries keep it and every exit drops it.

Nuke, one at a time: close acquisition, settle reclaim and the warm pool → release all leases `killed` → clear the warm pool's learned kinds → shut down each unleased `ready` virtual device and, with delete, destroy each `shutdown` one, then the seeds and every baseline. A device it cannot reset is logged and the rest go on.

Components:

- `ComponentInstaller` is the only caller of `installComponent` and `removeComponent`. One queue per platform, first come; a call for the same component joins. One `DiskSpaceGuard` serves both platforms.
- A removal marks the component under the lock, so `claimProvision` throws `ComponentBeingRemovedError` until it ends.

Baselines (ADR 0061 §4):

- One save or remove at a time. A save: leasing's `releaseToSave` ends the lease, then `ReclaimCoordinator.retireSaved` calls `driver.saveSource` under the `reclaim` claim. A driver failure quarantines the device and answers `BASELINE_SAVE_FAILED`.
- A replace keeps the leased devices of older versions. An older version is dropped only when no device record and no provision (`hold`) has it; that is checked after a save, on every `device.deleted` and at startup.
- `remove` refuses a baseline a lease uses, and destroys each source before its row. `removeAll` (nuke) deletes rows first.
- `checkStale` runs before `list` and `doctor` and after `component.removed`.

## Known gaps

- **A rollback keeps a stale quarantine cause.** An older daemon keeps `quarantineCause` unknown; re-entry under it shows the old one.
- **One download at a time per platform.** A second missing runtime waits, spending its own `downloads.timeoutMs`. A bounded model with no `--os` asks Xcode for a bare major; pass `--os`.
- **`component remove` sees only this instance.** One worker per user, so this matters for test roots and a second OS user. Another instance's devices, never-used default-set simulators and foreign devices made after the driver's count are not counted.
- **An older Simlock cannot end a physical lease.** It skips `physicalDevices`; `beginRelease` throws `UnknownDeviceError`. Release physical leases before a rollback.
- **Two instances can enrol one device.** Only test roots and a second OS user can run a second instance. Each release uninstalls apps not on its own list. Enrol a device in one instance only.

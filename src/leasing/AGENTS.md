# Leasing

Does: every lease rule on a worker — admit, queue, plan, grant, renew, end, recover.
Flows: [device selection](../../docs/internal/flows/device-selection.md), [startup](../../docs/internal/flows/startup.md).

## Rules

Order of a lease: admit → resolve → plan → perform → plan again → grant → renew → end → lease-end participants → reclaim.

The lock:

- One `SerializedDecision` per core, shared with core's reclaim, warm pool and registry writers. Read-decide-commit runs under it; driver I/O never does.
- Admit, plan and grant run under the lock. Resolve and perform (provision, boot, evict) run outside it, and a new plan follows every perform.
- A grant is one registry commit: device `leased`, lease and request together.
- Events go out after the commit that made them true.
- A physical device's presence is read outside the lock and checked again inside it before the grant.

The queue:

- `LeaseRequestBook.admit` stores the request before it queues it.
- Only the head of the virtual line plans; every physical waiter plans.
- A request's queue timeout is fixed at its first enqueue.
- A waiting reason is never stored: not in `state.db`, not in an event. The waiter keeps it in memory from its latest enqueue; `waitingRequests()` lists it on a `queued` entry, never on a `starting` one.
- A first provisioning failure plans again at once; a second rejects the waiter with `ProvisionFailedError`, a probe included, and wakes the queue.
- A boot failure destroys the device. A destroy that fails hands it to core's quarantine through a port leasing declares, and the waiter's slot is freed either way.
- Cancelling a queued waiter wakes the queue; a physical one mid presence read wakes it after its claim is released.
- A grant of a ready device wakes the queue, so the next waiter plans without another event.
- A device made from an older baseline version is never granted: a copy that finishes after a save is deleted at the grant check, and its waiter plans again.
- A request naming a baseline attempts no download.
- A request with `except` (ADR 0066) boots with the list. A ready warm device is shut down and prepared again under its `boot` claim, with no capacity reservation (plan `reboot-ready`, `ManagedDeviceLifecycle.rebootForLease`), except that at `new-devices-paused` the request waits `memory-pressure` instead; the grant is `booted`. Any failure of that reboot or of a boot destroys the device and counts one failure with a failed provision. A request without `except` that fails to boot rejects `boot-timeout`.
- A slim baseline's `except` names go to `driver.resolveSpec` too, so an unknown name is `BAD_REQUEST`; a full baseline refuses `except`.

Ending a lease:

- Every ending goes through `LeaseReleaseCoordinator`: one commit puts the device in `reclaiming`.
- A closed connection ends no lease.
- Lease-end participants run after that commit, outside the lock, with an `AbortSignal` bounded by `lease.endWaitMs`. Reclaim waits for them.
- Reclaim deletes a virtual device whatever `lease.identity` says (ADR 0061 §2), and quarantines on failure.
- A leased physical device read not present for `health.stableObservations` reads ends its lease as `device-lost`, with no reclaim.
- No background job acts on a leased device. The one exception is the health monitor, and it acts under the lease.
- `releaseToSave` ends the lease `explicit`, then runs `save` in the reclaim's place under the `reclaim` claim, so nuke's maintenance waits for it.

Holds, stop and start:

- `holdForUpdate()` is apart from `beginMaintenance`, so the warm pool and reclaim go on: nuke stops them, an update does not. It refuses every request not provisioning right now; one already provisioning is granted. Renew and release never go through admission.
- `settleAcquisitions()` stops planning for good and waits for every request already provisioning or booting. The daemon calls it in `dispose` before any driver is disposed, so a stop never disposes a driver under a running boot (#1200).
- A daemon start fails every request the previous process left open, as `daemon-restarted`.
- The gateway forwards renews; it runs no timers of its own.

Boundaries:

- Every lease rule lives here. Core reaches leasing only through the ports `createLeasing` builds.
- `createLeasing` takes `LeasingConfig` (`lease`, `health`), never the whole config.

## Known gaps

- **A crash mid-reboot of a warm device for an `except` lease** leaves the request failed at startup (`daemon-restarted`) and a `ready` record whose simulator may be shut down; startup's reconcile only reports that drift. A later grant of it is caught by the health monitor, which reboots it under the lease.
- **A SIGKILLed holder keeps its device until the TTL.** It runs no release.
  Bound it with `lease.defaultTtlMs` or `--ttl`; `simlock release <id>` ends it now.
- **Recovery restores the disk, not the session.** Apps, log streams and
  port forwards inside the device die with it; the holder gets
  `device-unhealthy` and must rebuild them. Detection takes up to
  `health.probeIntervalMs` × `health.stableObservations`.
- **Abort does not stop device work.** `lease.cancel` during provisioning
  answers `not-cancellable`. The client waits, releases a late grant, and
  reports `CANCELLED`. Use a tight `timeoutMs` instead.

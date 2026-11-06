# Leasing

Does: every lease rule on a worker — admit, queue, plan, grant, renew, end, recover.
Entry: `index.ts` → `createLeasing({ core, ... })`, built on `createCore`'s services.
Uses: core, bus, contract, ports. Never imports: drivers, gateway, daemon.
Imported by: daemon (all of it); gateway (request book, in-memory store, wait queue only).
Flows: [device selection](../../docs/internal/flows/device-selection.md), [startup](../../docs/internal/flows/startup.md).

## Files

| File                                      | Role                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `create-leasing.ts`                       | Composition root; builds `corePorts` for `core.connect`                                           |
| `lease-acquisition-coordinator.ts`        | Admission, spec resolution, plan → perform loop, grant                                            |
| `acquisition-planner.ts`                  | Read-only plan; takes the claim or reservation it hands back                                      |
| `wait-queue.ts`                           | FIFO, two lines (virtual, physical), timeouts, cancel; `requesterLimitDecision`                   |
| `lease-request-book.ts`                   | Request records: store before queue, idempotent replay, settle once                               |
| `lease-lifecycle.ts`                      | Registry half of grant, renew, release                                                            |
| `lease-expiry-scheduler.ts`               | TTL timers                                                                                        |
| `lease-release-coordinator.ts`            | Every lease ending; lease-end participants; background reclaim                                    |
| `lease-health-monitor.ts`                 | Reboots a crashed leased virtual device under its lease                                           |
| `physical-device-watcher.ts`              | Presence polling of enrolled physical devices                                                     |
| `lease-startup.ts`, `lease-reconciler.ts` | Lease half of startup                                                                             |
| `lease-refusal.ts`                        | `lease.rejected`, or `lease.declined` for a gateway request                                       |
| `lease-ports.ts`                          | `LeaseCommands`, `QueueControl`, `LeaseEndParticipant`                                            |
| `testing.ts`                              | Builds core + leasing for other modules' tests; `TestEngineConfig` is the config slice that takes |

## The update hold

`holdForUpdate()` (on the `Leasing` handle, typed `UpdateHold`) closes admission and refuses every request not provisioning right now, whatever its state (`new`, queued, re-queued, or retrying after a failed provision), with `DaemonUpdatingError` (`DAEMON_UPDATING`, `lease.rejected` reason `updating`); `releaseUpdateHold()` reopens it. It is apart from `beginMaintenance` so the warm pool and reclaim go on: nuke stops them, an update does not. Renew and release never go through admission, so held leases work as usual. A request already provisioning when the hold begins is granted; the check runs in `lease-acquisition-coordinator.ts` before every provision starts.

## How it works

Lock: one `SerializedDecision` per core, shared with core's reclaim, warm pool
and registry writers. Read-decide-commit runs under it; driver I/O never does.

1. **Admit** (lock) — `LeaseAcquisitionCoordinator.request`: replay by
   idempotency key + requester → refuse under the update hold (`DaemonUpdatingError`, `lease.rejected` reason `updating`) → refuse under maintenance → refuse a requester
   at `lease.maxPerRequester` (1; a number, or one per platform) or with a pending request
   on its platform (`requesterLimitDecision`) → refuse a taken
   `leaseId` → `LeaseRequestBook.admit` stores the request, then queues it.
   Emits `lease.requested`.
2. **Resolve** (no lock) — request → spec: default mode, class or OS range →
   exact model and runtime, `driver.resolveSpec`. May install a runtime when
   `allowDownload`. Physical requests skip this. See device selection.
   A request naming a baseline resolves against `core.baselines` instead: unknown,
   mismatch (`baselineMismatch`) or stale fails at once, and the spec is the
   baseline's, with its name and version; no download is attempted.
3. **Plan** (lock) — `AcquisitionPlanner.plan`; first that applies wins:
   grant a ready fitting device (a slim request with `except` takes it with a `boot` claim and no capacity reservation instead, `reboot-ready`) → wait for one the warm pool is booting →
   boot a shut-down one → provision → evict an
   idle device (device or running limit) → wait, or `NO_CAPACITY` under `noWait`.
   Only the head of the virtual line plans; every physical waiter plans.
   Each plan first moves a waiting baseline request to the baseline's newest version. A device
   made from an older version is never granted: a copy that finishes after a save is deleted at the
   grant check and its waiter plans again.
   A blocked plan carries a reason (a capacity refusal, `behind-earlier-request`,
   `waiting-for-device` or `no-free-physical`). The waiter keeps it,
   in memory only, from its latest enqueue; `waitingRequests()` lists it on a `queued`
   entry, never on a `starting` one. `NoCapacityError` carries it too. Cancelling a queued
   waiter (a physical one mid presence read wakes it after its claim is released) wakes
   the queue. A first provisioning failure plans again at once; a second rejects the
   waiter with `ProvisionFailedError` (the driver's message; `PROVISION_FAILED`), a probe
   included, and wakes the queue.
4. **Perform** (no lock) — provision, boot or evict through core, then plan again.
   A request with `except` (ADR 0066) boots with the list: a ready warm device is shut down and prepared again under its `boot` claim (`ManagedDeviceLifecycle.rebootForLease`; its record stays `ready`, and the grant is `booted`), a shut-down or new device boots with it. Any failure of those boots destroys the device (a failed reboot first records it `shutdown`) and counts one failure with a failed provision: the first plans again, the second rejects `PROVISION_FAILED`.
   A boot failure of a request without `except` destroys the device and rejects `boot-timeout`; a destroy
   that fails hands the device to core's quarantine through a port leasing
   declares, and the waiter's slot is freed either way.
5. **Grant** (lock) — `LeaseLifecycle.grant` → one registry commit: device
   `leased` (with the request's `except` when the device is slim) + lease + request granted. Emits `lease.granted`. Arms the TTL. A grant of a ready
   device wakes the queue, so the next waiter plans without another event.
6. **Renew** — moves `ttlDeadline`; emits `lease.renewed`. The gateway forwards
   renews; it runs no timers of its own.
7. **End** — explicit release, TTL expiry, `device-lost` (health monitor or
   physical watcher), release-all (nuke), or startup. All go through
   `LeaseReleaseCoordinator`: one commit puts the device in `reclaiming` and
   emits `lease.released` or `lease.expired`. `releaseToSave(leaseId, save)` (core's
   `leaseSave` port, for `baseline.save`) ends the lease `explicit` the same way, then runs
   `save` in the reclaim's place under the `reclaim` claim, as a normal release workflow
   that nuke's maintenance waits for.
8. **Lease-end participants** — called after that commit, outside the lock,
   with an `AbortSignal` bounded by `lease.endWaitMs`. Today: agent-device's
   `AgentDeviceLeaseEnd` and the stream's `createStreamLeaseEnd`. Reclaim waits for them.
9. **Reclaim** (background, `reclaim` claim) — core's `ReclaimCoordinator`
   deletes a virtual device (shutdown, then destroy: it serves one lease,
   whatever `lease.identity` says, ADR 0061 §2), or wipes a physical one and
   commits the state the driver returns; it quarantines on failure. Then it
   kicks the queue and the warm pool.

Physical branch: plan picks the first ready, unclaimed, fitting enrolled
device under a `grant` claim; presence is read outside the lock and checked
again inside it before the grant. A leased device read not present twice ends
its lease as `device-lost` with no reclaim.

`settleAcquisitions()` (on the `Leasing` handle) stops planning for good and waits for every request already provisioning or booting (a queued request starts nothing and ends with the daemon); the daemon calls it in `dispose`, before any driver is disposed, so a stop never disposes a driver under a running boot (#1200).

## State and timers

| What                            | Default             | Key                                                      |
| ------------------------------- | ------------------- | -------------------------------------------------------- |
| Lease TTL                       | 15 min              | `lease.defaultTtlMs` (cap `lease.maxTtlMs`, 4 h)         |
| Wait for lease-end participants | 10 min              | `lease.endWaitMs`                                        |
| Queue timeout                   | none                | request `timeoutMs`, fixed at first enqueue              |
| Health and presence tick        | 30 s                | `health.probeIntervalMs`                                 |
| Reads before a crash or absence | 2                   | `health.stableObservations`                              |
| Recovery attempts               | 3, backoff from 5 s | `health.maxRecoveryAttempts`, `health.recoveryBackoffMs` |

Writes go through core's `Registry` (`state.db`). Request states: `open` →
`granted` | `failed` | `cancelled`. Waiter states live in memory only.

## Rules

- A lease ends only by release or TTL. A closed connection ends nothing.
- A grant is one commit: device, lease and request together.
- Events go out after the commit that made them true.
- No background job acts on a leased device. The one exception is the
  health monitor, and it acts under the lease.
- `createLeasing` takes `LeasingConfig` (`lease`, `health`), not the whole config.
- Every lease rule lives here. Core reaches leasing only through the ports
  `createLeasing` builds.
- A daemon start fails every request the previous process left open,
  as `daemon-restarted`.
- A waiting reason is never stored: not in `state.db`, not in an event.

## Known gaps

- **A crash mid-reboot of a warm device for an `except` lease** leaves the request failed at startup (`daemon-restarted`) and a `ready` record whose simulator may be shut down; startup's reconcile only reports that drift. A later grant of it is caught by the health monitor, which reboots it under the lease.

- **A SIGKILLed holder keeps its device until the TTL.** It runs no release.
  Bound it with `lease.defaultTtlMs` or `--ttl`; `simlock release <id>` ends it now.
- **Recovery restores the disk, not the session.** Apps, log streams and
  port forwards inside the device die with it; the holder gets
  `device-unhealthy` and must rebuild them. Detection takes up to
  `probeIntervalMs × stableObservations` (about 60 s).
- **Abort does not stop device work.** `lease.cancel` during provisioning
  answers `not-cancellable`. The client waits, releases a late grant, and
  reports `CANCELLED`. Use a tight `timeoutMs` instead.

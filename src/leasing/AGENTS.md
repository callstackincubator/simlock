# Leasing

Does: every lease rule on a worker — admit, queue, plan, grant, renew, end, recover.
Entry: `index.ts` → `createLeasing({ core, ... })`, built on `createCore`'s services.
Uses: core, bus, contract, ports. Never imports: drivers, gateway, daemon.
Imported by: daemon (all of it); gateway (request book, in-memory store, wait queue only).
Flows: [device selection](../../docs/internal/flows/device-selection.md), [startup](../../docs/internal/flows/startup.md).

## Files

| File                                      | Role                                                                |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `create-leasing.ts`                       | Composition root; builds `corePorts` for `core.connect`             |
| `lease-acquisition-coordinator.ts`        | Admission, spec resolution, plan → perform loop, grant              |
| `acquisition-planner.ts`                  | Read-only plan; takes the claim or reservation it hands back        |
| `wait-queue.ts`                           | FIFO, two lines (virtual, physical), timeouts, cancel               |
| `lease-request-book.ts`                   | Request records: store before queue, idempotent replay, settle once |
| `lease-lifecycle.ts`                      | Registry half of grant, renew, release                              |
| `lease-expiry-scheduler.ts`               | TTL timers                                                          |
| `lease-release-coordinator.ts`            | Every lease ending; lease-end participants; background reclaim      |
| `lease-health-monitor.ts`                 | Reboots a crashed leased virtual device under its lease             |
| `physical-device-watcher.ts`              | Presence polling of enrolled physical devices                       |
| `lease-startup.ts`, `lease-reconciler.ts` | Lease half of startup                                               |
| `lease-refusal.ts`                        | `lease.rejected`, or `lease.declined` for a gateway request         |
| `lease-ports.ts`                          | `LeaseCommands`, `QueueControl`, `LeaseEndParticipant`              |
| `testing.ts`                              | Builds core + leasing for other modules' tests                      |

## How it works

Lock: one `SerializedDecision` per core, shared with core's reclaim, warm pool
and registry writers. Read-decide-commit runs under it; driver I/O never does.

1. **Admit** (lock) — `LeaseAcquisitionCoordinator.request`: replay by
   idempotency key + requester → refuse under maintenance → refuse a requester
   at `lease.maxPerRequester` (1) or with a pending request → refuse a taken
   `leaseId` → `LeaseRequestBook.admit` stores the request, then queues it.
   Emits `lease.requested`.
2. **Resolve** (no lock) — request → spec: default mode, class or OS range →
   exact model and runtime, `driver.resolveSpec`. May install a runtime when
   `allowDownload`. Physical requests skip this. See device selection.
3. **Plan** (lock) — `AcquisitionPlanner.plan`; first that applies wins:
   grant a ready fitting device → wait for one the warm pool is booting →
   boot a shut-down one → provision → evict an
   idle device (device or running limit) → wait, or `NO_CAPACITY` under `noWait`.
   Only the head of the virtual line plans; every physical waiter plans.
   A blocked plan carries a reason (a capacity refusal, `behind-earlier-request`,
   `waiting-for-device` or `no-free-physical`). The waiter keeps it,
   in memory only, from its latest enqueue; `waitingRequests()` lists it on a `queued`
   entry, never on a `starting` one. `NoCapacityError` carries it too. Cancelling a queued
   waiter (a physical one mid presence read wakes it after its claim is released) wakes
   the queue. A first provisioning failure plans again at once; a second rejects the
   waiter with `ProvisionFailedError` (the driver's message; `PROVISION_FAILED`), a probe
   included, and wakes the queue.
4. **Perform** (no lock) — provision, boot or evict through core, then plan again.
   A boot failure destroys the device and rejects `boot-timeout`; a destroy
   that fails hands the device to core's quarantine through a port leasing
   declares, and the waiter's slot is freed either way.
5. **Grant** (lock) — `LeaseLifecycle.grant` → one registry commit: device
   `leased` + lease + request granted. Emits `lease.granted`. Arms the TTL.
6. **Renew** — moves `ttlDeadline`; emits `lease.renewed`. The gateway forwards
   renews; it runs no timers of its own.
7. **End** — explicit release, TTL expiry, `device-lost` (health monitor or
   physical watcher), release-all (nuke), or startup. All go through
   `LeaseReleaseCoordinator`: one commit puts the device in `reclaiming` and
   emits `lease.released` or `lease.expired`.
8. **Lease-end participants** — called after that commit, outside the lock,
   with an `AbortSignal` bounded by `lease.endWaitMs`. Today: agent-device's
   `AgentDeviceLeaseEnd` and the stream's `createStreamLeaseEnd`. Reclaim waits for them.
9. **Reclaim** (background, `reclaim` claim) — core's `ReclaimCoordinator`
   wipes the device and commits the state the driver returns (iOS `shutdown`;
   Android `ready`, or `shutdown` after a full clean, a changed config or a
   failed snapshot load), deletes a spent
   `fresh` device, or quarantines on failure. Then it kicks the queue and the
   warm pool.

Physical branch: plan picks the first ready, unclaimed, fitting enrolled
device under a `grant` claim; presence is read outside the lock and checked
again inside it before the grant. A leased device read not present twice ends
its lease as `device-lost` with no reclaim.

## State and timers

| What                            | Default             | Key                                                      |
| ------------------------------- | ------------------- | -------------------------------------------------------- |
| Lease TTL                       | 15 min              | `lease.defaultTtlMs` (cap `lease.maxTtlMs`, 4 h)         |
| Wait for lease-end participants | 10 min              | `lease.endWaitMs`                                        |
| Queue timeout                   | none                | request `timeoutMs`, fixed at first enqueue              |
| Health and presence tick        | 30 s                | `health.probeIntervalMs`                                 |
| Reads before a crash or absence | 2                   | `health.stableObservations`                              |
| Recovery attempts               | 3, backoff from 5 s | `health.maxRecoveryAttempts`, `health.recoveryBackoffMs` |

Writes go through core's `Registry` (`state.json`). Request states: `open` →
`granted` | `failed` | `cancelled`. Waiter states live in memory only.

## Rules

- A lease ends only by release or TTL. A closed connection ends nothing.
- A grant is one commit: device, lease and request together.
- Events go out after the commit that made them true.
- No background job acts on a leased device. The one exception is the
  health monitor, and it acts under the lease.
- Every lease rule lives here. Core reaches leasing only through the ports
  `createLeasing` builds.
- A daemon start fails every request the previous process left open,
  as `daemon-restarted`.
- A waiting reason is never stored: not in `state.json`, not in an event.

## Known gaps

- **A SIGKILLed holder keeps its device until the TTL.** It runs no release.
  Bound it with `lease.defaultTtlMs` or `--ttl`; `simlock release <id>` ends it now.
- **Recovery restores the disk, not the session.** Apps, log streams and
  port forwards inside the device die with it; the holder gets
  `device-unhealthy` and must rebuild them. Detection takes up to
  `probeIntervalMs × stableObservations` (about 60 s).
- **Abort does not stop device work.** `lease.cancel` during provisioning
  answers `not-cancellable`. The client waits, releases a late grant, and
  reports `CANCELLED`. Use a tight `timeoutMs` instead.

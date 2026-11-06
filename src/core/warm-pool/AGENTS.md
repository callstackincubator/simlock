# Warm pool

Does: decides which idle virtual devices stay booted, and keeps `warmPool.targets` and the kinds it learned from leases filled.
Flows: [startup](../../../docs/internal/flows/startup.md). Parent: [core](../AGENTS.md).

## Rules

Warm means virtual, `ready` and unleased.

Boundaries:

- `policy.ts` is pure. The converger revalidates every proposal (same state, no lease, no claim) before it acts.
- Acts only through `ManagedDeviceLifecycle` and `DeviceProvisioner`, never on a leased or claimed device.
- Leasing reaches the pool only through `CorePorts.warmPoolDemand` and `core.passWarmPool()`.
- The pool learns from committed facts on the bus, never from the lease path (ADR 0017 §3).
- Never installs: every target resolves through `warmPoolDemand.resolve` with downloads off, on every pass, and a missing runtime is a report, not a download.
- Reclaim commits the driver's state and decides nothing; keep or shut down is decided here.

Passes:

- One pass at a time; a trigger during a pass asks for one more pass.
- The plan runs under the lock; driver work runs outside it. A boot takes `tryReserveBoot` and a `boot` claim under the lock. A creation takes `tryReserveProvisioning` and provisions with an ownerless `boot` claim, dropped once ready, so a request may wait on it.
- Target and `waiting-request` boots and creations run beside the pass. Every attempted action ends in `kick()`, whether it worked or not.
- While nuke holds acquisition closed the pool does nothing, and a device shut down then is never booted back unasked. Nuke also clears the learned record.
- A device of a platform whose driver was refused at discovery is never proposed, boot or shutdown. It still holds its capacity slot, and `targeted()` still lists it to the reaper.
- Stop: `close()` at stop start; `drain()` finishes the pass and running boots and starts nothing; `dispose()` cancels the timers.

The plan (`evaluate`), in this order: pool off → over budget → the queue → never-leased idle devices → configured targets → learned kinds.

- Over budget shuts down idle devices only, never one a waiting request would take, and none while a booted device is on its way to a lease.
- The queue is served oldest first, one device per waiter and one waiter per device. Nothing is created for the head, or for a waiter whose earlier waiters are all matched to a ready device: leasing creates for those.
- No target is filled while a waiter on its platform is one the pass could not serve.
- Every configured count fills before any learned count.
- Only displacement shuts a device down for a target or learned kind, and never one a configured count keeps; what does not fit is reported short. Nothing is displaced when the capacity strategy would still refuse the kind after the shutdown.
- `reserveRunning` holds slots from idle devices only; it never holds back a request.
- An `unresolvable` target keeps its last spec, so its devices stay spared.

Learned kinds:

- A kind is learned on `lease.granted`, never for a physical device and never with the pool off. A plain kind is learned on its first lease.
- A baseline kind is one row per baseline name, learned once its grants in the window reach `warmPool.baselineLearnAfter`. The mark is stored and never worked out again. Until then the row counts but is not planned, not in `figures()` or `targeted()`, and not matched by `forgetKinds`. Each pass warms it as the baseline's newest version.
- `start()` closes the lease rows whose lease the registry no longer holds.
- The catalog check forgets a kind whose model, OS, image tag or driver is gone, or whose baseline is removed or stale. `LEARNED_FAILURES_LIMIT` (`converger.ts`) failed boots in a row forget it too.
- A kind whose platform has no catalog answer yet (read pending, failed or timed out) is kept and planned for nothing that pass.
- `forgetKinds` (ADR 0050) drops a kind's failed-boot count unless a configured target shares its spec. The devices the kind kept are left to the reaper's idle rules.
- The learned kinds are the pool's own `state.db` tables (`warmPoolOwner`), kept across restarts and cleared by nuke. Targets are config.

What others read:

- `targeted()` lists what the reaper's `idle-shutdown` spares: each target's and learned kind's ready, unleased, unclaimed devices up to its count, and every such device a waiter not in flight could be granted. Demand is read on every call, so a cancellation removes that protection. With no pass yet it resolves the targets first; with the pool off it returns none.
- `figures()`: before the first pass, or with the pool off, they are the configured targets from config. A merged kind is listed once, with the larger count.
- `warm-pool.target-missed` covers configured targets only, by the configured count: once per report that is short now and has not missed since it was last met.
- A target key outside the known ones, a class included, fails the config load.

## Known gaps

- **A warm target costs one create per lease.** Every virtual device serves one lease (ADR 0061 §2), so each grant spends a
  device; the pool creates and boots the next one off the lease path. It holds a slot and RAM while
  it waits; a burst larger than the peak pays the boot. A learned kind keeps `max(peak - leased, 1)` ready while its copies are leased, a baseline kind counting those of every version (ADR 0069).
- **A failing target retries forever.** The delay doubles from `RETRY_FIRST_MS` up to `RETRY_MAX_MS`, with no attempt limit; each
  try boots or creates a device. `retry.ts` is the one place to add a limit.

# Stage 03 — Adaptive warm pool

Goal: reduce repeat lease latency by purging released devices and keeping them
running as an adaptive, capacity-bounded cache.

## Product outcome

When an agent releases a device, Pitlane returns it to a known clean baseline.
If running capacity permits, the device stays booted and immediately eligible
for the next matching lease. A repeated request should therefore avoid the
roughly 30-second cold-boot floor.

The warm pool is not configured per spec. It learns from actual lease demand:
recently used devices remain ready, while active requests evict stale warm
devices when capacity is needed.

Stage 02 is a required dependency. Its global and per-platform `maxRunning`
limits are the only warm-pool size controls.

## Terms and lifecycle

A **warm device** is any registry-managed device that is:

- running and readiness-checked;
- unleased;
- in `ready` state and immediately eligible for acquisition.

Warm pool membership is derived from those facts; `warm` is not a separate
device state. Retire the existing `warm` state and migrate any persisted
records by shutting those devices down through the normal driver path before
they become eligible again. Never reinterpret a legacy `warm` record as a
clean `ready` device. The shared lifecycle relevant to this feature is:

```text
ready → leased → reclaiming → ready
                            ↘ shutdown → deleted
```

`reclaiming` is the release-time purge phase. It includes any reset, boot, and
readiness work required before the device can be reused. A reclaiming device:

- remains counted as running;
- is busy and cannot be leased, evicted, shut down, or deleted by another
  workflow;
- becomes eligible only after the transition to `ready` commits.

Use the existing platform-agnostic `reclaiming` term in the public state
model. Do not add platform-specific `erasing`, `snapshotting`, or `purging`
states.

## Release workflow

Every lease-ending path uses the same workflow, including holder disconnect,
explicit release, TTL expiry, and force release:

1. Remove the lease and atomically transition the device from `leased` to
   `reclaiming`.
2. Purge the previous lease's state back to Pitlane's known clean baseline.
3. Decide the device's disposition against current demand and running limits:
   - keep it running and transition it to `ready` when it may remain warm;
   - otherwise shut it down and transition it to `shutdown`.
4. Wake the FIFO queue after the committed transition.

Purging always happens on release, even when the final disposition is
`shutdown`. If a queued request needs the released device's running slot for a
different spec, do not perform an additional boot merely to transition it
through `ready` before shutdown. The platform's purge mechanism may itself
need to boot the device to restore and validate its baseline.

A queued request for the same spec waits while the device is `reclaiming`, then
receives it as soon as it becomes `ready`. It never observes or receives the
previous lease's in-progress purge.

## Capacity policy

There is no warm-pool-specific minimum, maximum, reservation, or per-spec
configuration. Warm devices consume the same capacity as leased devices.

The maximum possible warm count is the running capacity left after leased and
reclaiming devices consume their slots. Active leases may consume every slot,
leaving no warm pool. Lowering a limit may temporarily leave leased devices
over capacity; Stage 02's safety behavior remains authoritative.

The warm pool never causes Pitlane to:

- exceed a global or platform `maxRunning` limit;
- reserve a slot that an active lease request could use;
- provision a device merely to fill unused capacity;
- proactively boot a shutdown device merely to fill unused capacity.

Provisioning, booting, reclaiming, and eviction decisions continue through the
lease engine's serialized decision path. In-flight reservations remain
load-bearing so concurrent releases and requests cannot oversubscribe a limit.

## Adaptive eviction

Active demand takes priority over warm inventory.

When the head request has no matching ready device and starting its matching
shutdown or newly provisioned device would exceed `maxRunning`, Pitlane:

1. selects the least-recently-used eligible warm device whose shutdown would
   free the blocked capacity;
2. shuts that victim down through the normal driver and registry path;
3. starts or provisions the requested device only after capacity is committed
   as free.

LRU is based on the end time of the device's most recent lease. Selection must
be deterministic when timestamps tie.

Victim scope follows the constraint:

- if a platform limit is blocking, select a victim from that platform;
- if only the global limit is blocking, select the global LRU victim across
  all platforms.

Never select a leased or reclaiming device. Preserve the existing FIFO wait
queue: a later request does not bypass the head merely because its spec already
has a warm device.

`--no-wait` still means "do not enter the queue," not "perform no work." If an
eligible victim can be selected immediately, eviction and acquisition may
proceed; otherwise return the existing capacity error.

### Managed-device eviction

Shutting down a warm device frees running capacity but does not free the
existing per-platform `maxDevices` capacity.

If a request needs a spec that is not already managed and `maxDevices` is also
full, delete the least-recently-used unleased managed device from the requested
platform to admit the request. Shutdown devices participate in this disk-cache
eviction and can be deleted without first choosing a running victim. A ready
victim is shut down before deletion. Leased and reclaiming devices remain
protected.

Only registry-managed devices are eligible, and every shutdown/deletion uses
the normal driver verbs and attributable events. If eviction fails, do not
oversubscribe either limit; leave or return the request to the queue.

## Idle cleanup

Warm devices retain the existing tiered cleanup behavior:

- after T1 since the most recent lease ended, transition `ready → shutdown`;
- after T2, normal idle destruction may transition `shutdown → deleted`.

The first version does not refill the pool after T1 shutdown. A later real
lease may boot the shutdown device, and its subsequent release may make it
warm again.

An active request that needs capacity evicts eligible warm inventory
immediately; it does not wait for T1.

## Startup and reconciliation

The feature is release-driven, not proactively warmed.

After startup reconciliation:

- retain already-running, unleased, ready devices when they are within T1 and
  the running limits;
- shut down excess devices in LRU order until both global and platform limits
  are satisfied;
- never boot shutdown devices to fill free slots;
- never provision devices to fill free slots;
- never touch a leased or non-registry device while converging.

This preserves a warm pool across a daemon restart without creating new warm
work merely because the daemon started.

## Clean-baseline guarantee

"Purge" means return the device to a Pitlane-controlled clean baseline using
the fastest validated platform strategy. It does not require the same
mechanism on every platform.

### iOS

Use simulator erase as the standard purge, then boot and readiness-check the
simulator only when its disposition is `ready`.

### Android

An Android device's first provisioning flow must:

1. create the AVD;
2. perform a clean cold boot and readiness check;
3. capture and validate an explicit clean-baseline snapshot;
4. make the device eligible for its first lease only after the baseline exists.

Release-time purge restores that baseline. The baseline is immutable across
ordinary leases and shutdowns: never overwrite it with lease-mutated state or
with state left after a failed purge.

Tag the baseline with the AVD configuration, system-image, and emulator
identity needed to detect invalidation. When invalid, discard it, perform a
full wipe and clean boot, capture a replacement baseline, and only then return
the device to normal service. Snapshot restore may fall back to this full
rebuild; the clean-baseline guarantee is more important than the warm-path
latency.

## Purge failure — accepted first-version behavior

If release-time purge fails:

1. emit `device.purge-failed` after committing the resulting device state;
2. make a best effort to leave or return the device running and readiness-
   checked;
3. if it is running, transition it to `ready` and keep it eligible for lease;
4. continue to count it against `maxRunning` and apply normal LRU/T1 behavior.

This deliberately means `ready` does not provide an absolute freshness
guarantee in the first warm-pool version: another agent may observe apps or
data from the previous lease. The accepted risk and possible future quarantine
policy are documented in `docs/known-pitfalls.md`.

The failure event payload includes the device id, released lease id, attempted
strategy, duration, and a stable error summary. It must be self-contained
enough to measure failure frequency and impact.

Failure to boot or pass readiness is different from purge failure: a device
that is not actually running and ready cannot become eligible. Leave it
shutdown/unavailable, wake the queue, and let normal recovery or provisioning
satisfy demand.

## Status and observability

Keep the public state model small:

- `reclaiming` communicates that a released device is busy;
- `ready` communicates that it is unleased, running, and eligible;
- no `warm` state is exposed.

Extend status additively with derived warm counts globally and per platform.
Existing Stage 02 running, reserved, and over-limit fields remain
authoritative. Human status should make reclaiming devices and the warm count
visible without implying that warm capacity is reserved.

Successful purges continue to emit the existing `device.reclaimed` fact.
Evictions use existing `device.shutdown` and `device.deleted` events with a
warm-pool/active-demand initiator. `device.purge-failed` is cataloged as
planned in `EVENTS.md`; mark it implemented in the implementation change.

## Tests first

- **Load-bearing repeated-lease test:** capacity one; release transitions the
  device to `reclaiming`, a second matching request waits, purge completes,
  the device becomes `ready`, and the second lease is granted without another
  cold boot or provision.
- A reclaiming device cannot be leased, cleaned up, or selected as an eviction
  victim.
- Release purges the device even when its final disposition is `shutdown`.
- With free running capacity, release leaves the purged device ready.
- When leased devices consume all effective capacity or the system is over
  limit, release purges then shuts down the newly free device.
- A new-spec request at the platform limit evicts that platform's LRU warm
  device; a request blocked only by the global limit may evict the LRU device
  from the other platform.
- LRU ties are deterministic, and leased/reclaiming devices are never victims.
- FIFO remains strict when a later request matches an existing warm device.
- `--no-wait` performs an immediately available eviction but never queues.
- At `maxDevices`, a new spec destroys the LRU eligible managed device and is
  then provisioned; no unregistered device is touched.
- Eviction failure does not oversubscribe running or managed capacity.
- T1 shuts down a warm device; free capacity afterward triggers no proactive
  boot or provision.
- Startup retains eligible already-running devices, shuts down LRU excess,
  and never starts a shutdown device.
- Android provisioning captures and validates a clean baseline before the
  first grant.
- Android release restores the immutable baseline without replacing it.
- Android baseline invalidation performs a full clean rebuild and captures a
  replacement before reuse.
- Purge failure emits one self-contained `device.purge-failed` event and the
  running device remains eligible for a subsequent lease.
- A readiness failure never exposes the device as ready.
- Status JSON and human output report derived warm counts and reclaiming state.
- Persisted legacy `warm` records are shut down through the normal driver path
  and cannot be leased until a later purge/readiness flow succeeds.

## Implementation outline

1. Retire `warm` from the domain state machine and add a safe registry-state
   migration that shuts legacy warm devices down before reuse. Define warm
   membership as unleased `ready` devices.
2. Add a platform-agnostic warm-pool policy module for eligibility, LRU victim
   selection, release disposition, and startup convergence.
3. Integrate release-time purge and disposition as an explicit lease-engine
   transaction. Events remain observers only.
4. Integrate running and managed-capacity eviction into the existing FIFO
   acquisition decision path, using Stage 02 reservations.
5. Update idle cleanup so ready devices remain warm until T1, with no pool
   refill reaction.
6. Remove the placeholder `warmPool` configuration surface; `maxRunning` and
   T1 are the complete first-version policy controls.
7. Add explicit immutable baseline snapshot creation, restore, validation, and
   rebuild behavior to the Android driver.
8. Add purge-failure handling and `device.purge-failed`; update `EVENTS.md` in
   the same implementation change.
9. Extend daemon status, CLI rendering, configuration documentation,
   `ARCHITECTURE.md`, and `CLI.md`.

## Non-goals

- Proactive booting on daemon startup or when a slot becomes free.
- Provisioning devices without real lease demand.
- Per-spec warm quotas, minimums, reservations, or prediction.
- Priority queues or bypassing FIFO.
- iOS golden-device cloning or user-customized baselines.
- Quarantining or retrying a purge-failed but otherwise ready device.
- Changing the T1/T2 configuration model.

## Watch out

- A warm device is cache inventory, never reserved capacity.
- Never hold the lease engine's decision lock across driver work.
- Never start requested work until eviction has committed the freed capacity.
- Preserve registry-only destruction and never touch leased devices.
- Do not implement release disposition or eviction as event handlers.
- Emit purge failure only after the state it describes is committed.
- Do not let normal Android Quick Boot shutdown overwrite the immutable clean
  baseline.
- Do not silently treat readiness failure as the accepted purge-failure gap.

## Acceptance criteria

- [ ] A released device is purged and remains immediately leasable when
      running capacity permits.
- [ ] Reclaiming devices are busy, non-claimable, and count as running.
- [ ] Warm membership is derived from `ready`; the legacy `warm` state is
      safely retired.
- [ ] Warm inventory never reserves capacity or causes `maxRunning` to be
      exceeded.
- [ ] Active demand evicts the correct LRU device globally or per platform.
- [ ] New-spec demand can evict managed LRU inventory at `maxDevices` without
      touching leased, reclaiming, or unregistered devices.
- [ ] T1 shuts down idle warm devices, and no proactive refill occurs.
- [ ] Already-running warm devices survive reconciliation when within limits;
      startup never boots or provisions merely to fill the pool.
- [ ] Android has an explicit, validated, immutable clean baseline before its
      first lease and rebuilds it safely after invalidation.
- [ ] Purge failure is observable and the accepted eligible-reuse behavior is
      covered by tests and known-pitfall documentation.
- [ ] Status and events expose enough information to operate and measure the
      feature.
- [ ] FIFO, `--no-wait`, registry-only destruction, and leased-device safety
      invariants remain intact.
- [ ] `pnpm check` is green.

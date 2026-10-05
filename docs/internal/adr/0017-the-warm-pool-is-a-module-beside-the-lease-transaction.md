# 0017. The warm pool is a module beside the lease transaction, not a step in it

- **Status:** Proposed
- **Date:** 2026-10-05
- **Issue:** [#359](https://github.com/callstackincubator/simlock/issues/359)
- **Supersedes:** nothing. Replaces the "Warm pool" entry of
  [IDEAS.md](../IDEAS.md), which deferred proactive warmth. Narrows [ADR
  0002](0002-opt-in-slim-ios-simulators.md) §5: the pool absorbs the slim
  cost by policy, not by accident of a release. Leaves [ADR
  0007](0007-a-lease-request-chooses-the-device-mode.md) §6 (pool identity
  is the spec's mode) as it is. Narrows [ADR
  0015](0015-a-lease-request-is-a-set-of-constraints.md) §6: `fits` stays
  the one place a requirement meets a device, but the warm pool's keep
  decision now uses it, with the pool-mode test, instead of `sameSpec`;
  `sameSpec` still names pool identity for reclaim and the idempotency
  check. Also narrows ADR 0015 §6's planner order (ready, then shutdown,
  then provision) by one case: a device on its way that serves the request
  is a reason to wait before provisioning (§6 below).
- **Depends on:** [ADR 0015](0015-a-lease-request-is-a-set-of-constraints.md)
  for `fits`; the capacity strategies (ARCHITECTURE.md, "Running capacity")
  for every limit the pool asks about; architecture rules 14, 15 and 16.

## Context

A warm device is an unleased, clean, running device. A request it fits is
granted in under a second; any other request pays a boot of about thirty
seconds on iOS, twice that for a slim device. Today warmth has no owner.
Seven places decide what a warm device is or does, and the one named
`WarmPoolCoordinator` is mostly a reclaim coordinator: it purges a released
device, hands a failed purge to quarantine, deletes a spent `fresh` device,
recovers a reclaim a crash interrupted, and, in one private method, decides
whether the purged device may stay running. That method reads the oldest
waiting request's create spec out of the acquisition coordinator and
compares it to the device with `sameSpec`, so a released iPhone 15 that
fits a waiting `--class phone` request is shut down and an iPhone 17 booted
for it (#350). The startup converger enforces the same "how many idle
devices may run" rule a second time, with its own copy. The planner imports
the pool's LRU order for its evictions. The idle rules of the reaper drain
the pool on a timer under a config key that does not mention it.

Nothing is proactive: a device is warm only because a lease ended and
capacity happened to allow it to keep running. The first lease of the day
and the first lease of each model always boot; under `lease.identity:
fresh` every lease does. The operator cannot ask for two iPhone 17 to be
ready before the agents arrive, cannot keep a slot free for a model nobody
predicted, and cannot turn warmth off on a machine that needs its RAM back.
Task #76 proposed targets but tied them to the host activation handshake
of #70.

Coupling runs both ways between release, the warm pool and acquisition, so
the keep rule cannot be changed without touching the lease path, and the
lease path cannot be read without knowing the pool. #359 asks for targets,
a reserve, an off switch, and a keep rule that fits. This record decides
where that logic lives and how it relates to the lease transaction, because
the answer constrains every task under #359 and would be expensive to
reverse.

## Decision

### 1. Reclaim and warmth are two components

What happens to a released device is two questions with two owners.

The **reclaim coordinator** (`src/core/reclaim-coordinator.ts`, the renamed
`WarmPoolCoordinator`) is part of the lease transaction. After a release it
runs the driver's `reclaim`, commits exactly the state the driver returns
(`shutdown` after an iOS erase, `ready` after an Android snapshot restore),
emits `device.reclaimed`, and kicks acquisition. It keeps the quarantine
handoff, the spent `fresh` delete and the interrupted-reclaim recovery. It
no longer decides whether the device stays running, boots it back, or reads
the queue. `warmPool.quarantine.*` keeps its name and is read by the reclaim
coordinator; renaming a public key is not worth a migration.

The **warm pool** decides which clean, unleased devices should be running,
and acts on it. It is not a step of a lease: no request, grant, release or
reclaim waits on it.

### 2. The warm pool is one module with one surface

`src/core/warm-pool/` with an `index.ts` (architecture rule 14). Inside:

- `policy.ts`: a pure function from a view to proposals (architecture rule
  16). The view is the registry snapshot, the capacity figures, the waiting
  requests, the pool's config, the clock. A proposal is `shutdown`, `boot`
  or `provision` for one device or one target, with its reason.
- `converger.ts`: runs one pass at a time. It takes the proposals, claims
  each device, reserves capacity for each boot or provision, acts through
  `ManagedDeviceLifecycle` and `DeviceProvisioner`, and asks for another
  pass when something changed under it. At most
  `warmPool.maxConcurrentBoots` boots run at once (default 1).
- `config.ts`: the `warmPool.*` keys, their defaults and validator,
  composed into `Config` the way the capacity strategies are.

Changing the algorithm changes `policy.ts` and its tests. Nothing outside
the directory imports a file inside it.

### 3. Dependencies point into the core, never out of it

No component of the lease transaction imports, calls or holds a port to the
warm pool (architecture rule 15). The composition root (`LeaseEngine`) wires
the pool with: a read-only registry snapshot, the capacity coordinator's
questions and reservations, the acquisition coordinator's read-only
`waitingRequests()` and its read-only `resolve(request)`, which turns a
request's model, OS and mode into the create spec a driver would make for
it, or a refusal (`RUNTIME_MISSING`, `UNKNOWN_MODEL`), the same way a lease
request is resolved and in the same place (ADR 0007 §2, ADR 0015 §5): the
driver still decides whether a slim request gets a slim spec, and the pool
never stamps a mode itself. Then the device lifecycle and provisioner, the
claims, the bus, the clock, and a `kick` into acquisition.

The pool reacts to committed facts on the bus, as the reaper does:
`daemon.started` (which fires after startup convergence), `device.reclaimed`,
`device.quarantine-recovered`, `lease.granted`, `lease.released`,
`device.shutdown`, `device.deleted`, `cleanup.executed` and
`capacity.changed`, plus a slow tick as a backstop. The bus carries no step
of the lease workflow (architecture rule 5): the pool's own actions are
direct calls to the lifecycle verbs, and a pass that fails logs one line
and leaves every device in a named state.

The LRU order the planner uses for its evictions moves to
`src/core/idle-order.ts`, a neutral helper of domain. The planner, the
pool and nothing else import it. The planner keeps eviction by demand: when
running capacity is full, a waiting request shuts down the least recently
used idle device. That is a capacity rule, not a pool rule, and demand beats
warmth everywhere.

### 4. The budget is derived from capacity, and the pool owns one rule

How many idle devices may run is one rule, enforced in the pool
(architecture rule 10). Per platform and globally, the **warm budget** is
the running limit, minus `warmPool.reserveRunning` for that platform
(default 0), minus every running slot held by a leased, reclaiming or
quarantined device or by a reservation. RAM is not a count: for each
candidate boot or provision the pool asks the capacity coordinator the same
question the planner asks (`tryReserveRewarm`, `tryReserveProvisioning`),
so a reclaimed slim iOS device still needs room at full size for its boot
and slim pass. The pool counts per platform and mode, because a slim warm
device cannot serve a full request (ADR 0007 §6). The global budget
subtracts the sum of the per-platform reserves from the global running
limit.

The startup converger's excess-ready shutdown is deleted. The pool's first
pass, on `daemon.started`, shuts down whatever is over budget, by LRU, and
the converger keeps only what it had before that step: settling open
requests, restoring timers, recovering reclaims, deleting spent devices,
re-arming quarantine.

The pool never evicts for a target. It never bypasses the queue: while a
request is waiting for capacity on a platform, the pool makes no boot or
provision for a target on that platform. It never calls the component
installer: a target naming a runtime that is not installed is reported, not
downloaded (safety rule 4).

### 5. What a pass does

In order, within one pass:

A device **serves** a waiting request when it fits the request's
requirement (ADR 0015 §5) and its spec's mode is the mode the request
resolved to: the same two tests the planner applies before it grants, so a
slim device never serves a `full` request and a full device never serves a
`slim` one.

1. **Over budget.** Shut down idle ready devices, least recently used
   first, until the budget holds. A device that serves a waiting request is
   never chosen here.
2. **Keep.** A device the reclaim left `shutdown` (iOS) is booted back when
   it serves a waiting request, or when a target of its kind is short, or
   when the budget has room and it was released less than
   `idle.shutdownAfterMs` ago. The boot holds a rewarm reservation. A device
   the reclaim left `ready` (Android) stays as it is unless step 1 took it.
3. **Targets.** For each target below its count, boot a shut-down device of
   that kind if one exists, otherwise create one, up to the budget and the
   boot cap. A target is written the way a request is: a platform, an
   exact model, an optional OS version or range, an optional mode. On every
   pass the pool resolves each target through `resolve(request)` into a
   create spec, so a runtime installed since the last pass takes effect
   without a restart, and a target that resolves to a refusal is `short`
   with that reason. Two targets that resolve to the same spec are one
   target with the sum of their counts. A device is of a target's kind when
   `sameSpec` holds between it and that create spec.
   Under `lease.identity: fresh` the created device has never served a
   lease, serves one, is deleted by the reclaim coordinator, and the next
   pass creates the next.

A device that counts toward a target is **targeted**; a device kept by
step 2 without a target is **kept**. The reaper's idle-shutdown rule skips
targeted devices and keeps its timers for kept ones; the rule reads the set
of targeted device ids from its view, which the composition root fills from
the pool. Idle-destroy is unchanged.

`warmPool.enabled: false` is the policy that keeps nothing: every pass shuts
down every idle ready device, targets are ignored, and the reserve has no
effect. Android still purges through its snapshot restore; the pass shuts
the emulator down afterwards.

### 6. A request waits for a device on its way that serves it

The planner's rule gains one case, about device state and claims and not
about the pool: a device that serves the request and is either under a
`boot` claim or in `provisioning` is a reason to `wait`, not to provision
another. The pool's boots and creations and the planner's own
`boot-shutdown` and `provision` all leave that trace, so a request for a
device the pool is booting, or creating for a target, is granted the moment
it is ready, and a second request for the same model behind the first is
treated as it is today. Claims of other kinds (eviction, cleanup, nuke,
reclaim) keep making a device invisible.

### 7. What the operator sees

`status.get` gains a `warmPool` block: `enabled`, `reserveRunning`, and one
entry per target with its kind, `count`, `ready`, `booting`, and `short`
with a reason (`running-limit`, `device-limit`, `ram-budget`, `reserve`,
`runtime-missing`, `unknown-model`) when the pass ended below the count.
The protocol version rises by one. `simlock status` prints it; the console
shows it on the worker's page through the existing status route. A gateway
aggregates it per worker and holds no pool of its own.

`simlock doctor` gains `warm-pool-target-unreachable` for a target that
cannot be met as configured: a runtime not installed, a model the catalog
does not list, or a count above the platform's running limit minus its
reserve. It names the limit or the install command.

One event, `warm-pool.target-missed`, with the target's kind, `count`,
`ready` and the reason, fires when a pass first ends a target short and not
again until the target is met and missed again. Devices the pool shuts down
emit `device.shutdown` with initiator `warm-pool`; `device.ready` and
`device.provisioned` are unchanged.

### 8. Config

```jsonc
{
  "warmPool": {
    "enabled": true,                      // false: no idle device runs
    "reserveRunning": { "ios": 0, "android": 0 },
    "maxConcurrentBoots": 1,
    "targets": [
      { "platform": "ios", "model": "iPhone 17", "osVersion": "26.0", "count": 2 },
      { "platform": "ios", "model": "iPhone 17", "mode": "full", "count": 1 }
    ],
    "quarantine": { /* unchanged, read by the reclaim coordinator */ }
  }
}
```

Read at daemon start. `count` is a positive integer; a target with an
unknown key, such as `class`, fails the load with an error naming the key.
`osVersion` takes what a request's `--os` takes, a version or a range. A
target may name a runtime that is not installed or a model the catalog does
not list; both load and are reported by status and doctor.

## Consequences

- Warmth has one owner and one rule. #350 is fixed by construction: the
  keep decision asks whether the device serves a waiting request, with
  `fits` and the pool mode, in the one module that decides warmth. ADR 0015
  §6's "the warm pool" clause is narrowed to reclaim and the idempotency
  check.
- The first lease of a targeted kind is a warm hit, including under `fresh`
  identity. A targeted device holds RAM and disk for as long as it is
  configured; status shows it.
- Turning the pool off is one key, and the lease path does not change
  shape: the reclaim coordinator commits the driver's result either way.
- The lease path imports nothing from the pool, so a change to the policy
  cannot change what a grant or a release does, and the policy's tests run
  on a view with no engine. A request can still wait on a pool boot that
  serves it (§6); if that boot fails, the request falls back to its own
  plan on the next decision, bounded by the boot timeout and its deadline.
- The startup converger loses one step and one copy of the budget rule.
- A request for a device under a `boot` claim or in `provisioning` that
  serves it waits instead of creating another. The wait is bounded by the
  boot's own timeout and the request's own deadline, as today.
- The reaper reads one more thing from its view, the targeted set. With the
  pool off it is empty.
- Status, doctor and the catalog of events change, each with its docs. Two
  protocol bumps if status and the event land in different PRs.
- The gateway's `warm-hit` stage is untouched: it reads `ready` devices
  from status as before. Fleet-level targets are a later record.
- Not decided here, and out of scope for #359: targets named by class,
  changing targets without a restart, a non-erasing iOS clean that keeps a
  reclaimed device slim (ADR 0002 deferred it), and the host activation
  handshake of #76.

## Alternatives considered

- **Keep the decision in the reclaim flow and fix the `sameSpec`
  comparison.** The smallest fix for #350. Rejected: it leaves warmth with
  no owner and the release coordinator holding a port into acquisition, and
  the next change (targets) would need a second place to act.
- **Make the pool a step the release coordinator calls after the reclaim.**
  A direct call instead of an observer. Rejected: it keeps the lease path
  knowing the pool, so turning the pool off means a conditional in the
  release path, and the pool could not act on a grant or at startup without
  two more call sites.
- **Let the pool evict kept devices for a target.** Fills targets faster on
  a full machine. Rejected: a kept device was released by a real workload
  that may come back, and a target is a prediction; predictions do not shut
  down evidence.
- **A fraction of capacity instead of a reserve count** (#76's
  `maxCapacityFraction`). Rejected: on a two-slot machine a fraction either
  forbids warmth or allows all of it, and a count is what an operator
  reasons in.
- **Targets changed at runtime through an admin operation.** Deferred: it
  needs an operation on every transport and a rule for a gateway; nobody
  has asked for it yet.
- **Move `idle.shutdownAfterMs` into the pool's config.** The timer is the
  pool's eviction clock. Rejected for now: a public key would move for no
  behaviour change; the exemption of targeted devices is enough.
- **Have the planner ask the pool whether a device is being warmed.**
  Rejected: it points a dependency from the required to the optional. The
  claim kind carries the same fact without the pool.

# Warm pool

Does: decides which idle virtual devices stay booted, and keeps `warmPool.targets` filled.
Entry: `index.ts` → `WarmPool`, built by `createCore`; `start()` runs at the end of `core.converge`.
Uses: core (capacity, lifecycle, provisioner, claims, registry, lock), bus, ports, contract.
Leasing reaches it only through `CorePorts.warmPoolDemand` and `core.passWarmPool()`.
Flows: [startup](../../../docs/internal/flows/startup.md). Parent: [core](../AGENTS.md).

## Files

| File           | Role                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| `converger.ts` | `WarmPool`: triggers, one pass at a time, acts, `figures()`, `warm-pool.target-missed`   |
| `policy.ts`    | `evaluate`: pure; proposals and per-target reports; `targetedDevices`, `reservedRunning` |
| `retry.ts`     | `RetrySchedule`: a target's failed boot or creation, keyed by resolved spec              |
| `config.ts`    | `WarmPoolConfig`, `defaultWarmPoolConfig(systemStats)`, validators                       |
| `figures.ts`   | `WarmPoolFigures`, `WarmTargetFigures`                                                   |

## How it works

Warm = virtual, `ready`, unleased. Budget = running limit minus every slot a leased, reclaiming,
quarantined or reserved device holds (`RunningCapacity`), per platform and global.

1. **Trigger** — bus facts `daemon.started`, `device.reclaimed`, `device.quarantine-recovered`,
   `lease.granted`, `lease.released`, `lease.queued`, `device.shutdown`, `device.deleted`,
   `cleanup.executed`, `capacity.changed`; a 30 s tick; the retry timer; `core.passWarmPool()` (leasing, once a
   background reclaim drops its claim). A trigger during a pass asks for one more pass.
2. **Fence** — while nuke holds acquisition closed: do nothing, and remember each `shutdown`
   device; it is never booted back unasked.
3. **Resolve** — each target through `warmPoolDemand.resolve`, downloads off, every pass.
   A refusal is a report. An `unresolvable` target keeps its last spec, so its devices stay spared.
   A device of a platform whose driver was refused at discovery is never proposed — boot or
   shutdown — but still holds its capacity slot, and `targeted()` still lists it to the reaper.
4. **Plan** (lock) — `evaluate(view)`, first to last:
   - pool off: shut down every idle `ready` device (`disabled`);
   - over budget: shut down idle devices, LRU first, never one a waiting request would take;
     none while a booted device is on its way to a lease;
   - the queue, oldest first, one device per waiter and one waiter per device: an idle ready device or
     one on its way (`onItsWay`: `provisioning` or shut down under an ownerless `boot` claim) that
     serves it, else a shut-down device that serves it is booted, else a device of its spec is
     created (`waiting-request`), under `maxConcurrentBoots` counting the pool's flights, each
     in-flight waiter and the head's own work. No creation for the head or for a waiter every
     earlier waiter of which is matched to a ready device: leasing creates for those. A boot or
     creation the capacity strategy or the retry schedule refuses is not proposed;
   - then devices released less than `idle.shutdownAfterMs` ago, newest first, while room beyond
     the reserve is left;
   - shut down a device never leased, `ready` longer than `idle.shutdownAfterMs`, no target keeps;
   - targets: merge those of one spec (counts summed); boot a shut-down device of the kind, else
     create one, after the queue's devices. Not while a waiter on its platform is one the pass could not
     serve, not while `RetrySchedule` holds the spec, not past running slots, reserve, device limit,
     RAM or `maxConcurrentBoots`.
5. **Act** — each proposal revalidated (same state, no lease, no claim):
   - shutdown: `lifecycle.shutdown`, initiator `warm-pool`, `cleanup` claim;
   - boot (lock: `tryReserveBoot` + `boot` claim) → `bootWarm` → release both;
   - creation (lock: `tryReserveProvisioning`) → `provisioner.provision` with an ownerless `boot`
     claim, dropped once ready, so a request may wait on it.
     Target and `waiting-request` boots and creations run beside the pass. Every attempted action
     ends in `kick()`.
6. **Report** — emit `warm-pool.target-missed`, arm the retry timer.

`targeted()`: per target, its ready unleased unclaimed devices, oldest first, up to its count.
The reaper's `idle-shutdown` spares them. With no pass yet, it resolves the targets first.

Figures (`figures()`, read by `status.get`, doctor's `warm-pool-target-unreachable`, the console):
`enabled`, `reserveRunning`, and per kind `platform`, `model`, `osVersion`, `mode`, `count`, `ready`,
`booting`, `short`. Before the first pass, or with the pool off, they come from config.

`short`, the first that applies: `disabled`; set in the converger `no-driver`, `runtime-missing`,
`unknown-model`, `unresolvable`; set in the policy `boot-failed`, `device-limit`, `running-limit`,
`reserve`, `ram-budget`. None while filling or waiting behind a queued request the pass could not serve.

`warm-pool.target-missed`: once per report that is short now and whose configured targets have not
missed since they were last met (ready ≥ count). Payload: platform, model, osVersion, mode, count,
ready, reason.

Stop: `close()` at stop start; `drain()` finishes the pass and running boots, starts nothing;
`dispose()` cancels the timers.

## State and timers

| What                                             | Default                             | Key                              |
| ------------------------------------------------ | ----------------------------------- | -------------------------------- |
| Pool on                                          | `true`                              | `warmPool.enabled`               |
| Running slots idle devices may not fill          | 0 per platform, capped at its limit | `warmPool.reserveRunning`        |
| Targets                                          | none, at most 256                   | `warmPool.targets`               |
| Boots and creations in flight at once            | `max(1, floor(cpuCount / 4))`       | `warmPool.maxConcurrentBoots`    |
| Recently released, never-leased idle             | 10 min                              | `idle.shutdownAfterMs`           |
| Tick; pause after a failed keep boot or shutdown | 30 s                                | `WARM_POOL_TICK_MS`              |
| Target retry                                     | 60 s, doubling, cap 10 min          | `RETRY_FIRST_MS`, `RETRY_MAX_MS` |

Target keys: `platform`, `model`, `count` required; `osVersion` (version or range), `mode`.
Any other key, a class included, fails the load. Memory only: nothing is persisted.

## Rules

- `policy.ts` is pure. The converger revalidates every proposal before it acts.
- Acts only through `ManagedDeviceLifecycle` and `DeviceProvisioner`, never on a leased or
  claimed device.
- Never installs: a missing runtime is a report, not a download.
- A target never shuts a device down; what does not fit is reported short.
- `reserveRunning` holds slots from idle devices only; it never holds back a request.
- Reclaim commits the driver's state and decides nothing; keep or shut down is decided here.

## Known gaps

- **A warm target under `lease.identity` `fresh` costs one create per lease.** Each grant spends a
  device; the pool creates and boots the next one off the lease path. It holds a slot and RAM while
  it waits; a burst larger than `count` pays the boot.
- **A failing target retries forever.** 1, 2, 4 … minutes, at most 10 apart, no attempt limit; each
  try boots or creates a device. `retry.ts` is the one place to add a limit.

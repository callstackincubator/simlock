# Events

Catalog of business events carried on the daemon's event bus. Naming and
authoring rules live in [agent-rules/events.md](agent-rules/events.md) —
in short: `subject.past-tense-fact`, emitted post-commit, facts not commands.

> Status: **planned catalog** — update the Status column as events are
> implemented, and add new events here in the same change that introduces them.

> **The event `id` is a one-time exception to additive-only** for the event
> file, taken by [ADR 0014](adr/0014-an-event-has-one-id-minted-where-the-fact-happened.md)
> the way ADR 0004's was: every envelope gains a required `id`, and a line in
> `events.jsonl` without one is not replayed. History from before the upgrade
> is not shown.

> **The payload removals in the lease rows are a deliberate exception to
> events rule 6** ("treat payload shape as a public contract: additive
> changes only"), granted by [ADR
> 0004](adr/0004-ttl-first-leases-on-every-transport.md) in its Consequences:
> `lease.granted` loses `mode` and `lease.released` loses the `closed` and
> `orphaned` reasons, since neither concept exists any more — there is no
> connection close to release on, and no startup sweep to orphan anything.
> The ADR takes that exception once, while the package is 0.x; this note
> records it here so the catalogue does not read as a silent rule violation.
>
> [ADR 0007](adr/0007-a-lease-request-chooses-the-device-mode.md) §13 takes
> the same exception once more: `lease.requested` and `lease.rejected` carry
> the request, and `device.provisioned` the spec, so `full` leaves those
> payloads and `mode` enters (`requestSpec.mode`, `spec.mode`).
>
> [ADR 0015](adr/0015-a-lease-request-is-a-set-of-constraints.md) §9 takes
> it a third time: `lease.requested` and `lease.rejected` carry the request
> as it arrived, so `requestSpec.model` becomes optional (a request naming a
> class or nothing has none) and `requestSpec.class` enters. Making a
> required key optional is not additive. The exception covers
> `request.dispatched` too, which names the same request: `model` becomes
> optional and `class` enters, for the same reason.
>
> [ADR 0021](adr/0021-a-gateway-dispatch-is-a-probe-and-names-its-fleet-request.md)
> narrows ADR 0014 §6's "a worker's own events ... show what they always
> showed": a worker's events for a gateway's dispatch (a probe) carry
> `fleetRequestId`, and a refused probe is `lease.declined`, not
> `lease.rejected`. Its events for local requests are unchanged.

## Lease lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `lease.requested` | request id, request spec (platform, `model` only when the request named one, `class` when it named one -- a request naming neither carries neither, ADR 0015 §9, os version -- an exact version or an OS range as typed, ADR 0015 §2, device `mode` as the request named it -- absent when it named none, since the worker's default is applied after this event, ADR 0007 §2; `imageTag` when the request named one, #214, additive), requester, wait policy, `fleetRequestId` on a worker's event for a gateway's dispatch (a probe; ADR 0021 §3, additive, events rule 6) | a lease request is accepted by the daemon and stored; the request id is the stored request's, so an observer can match this event to it (#72 added the id; additive, events rule 6) | LeaseAcquisitionCoordinator (worker) / FleetLeaseCoordinator (gateway, ADR 0005 §11 — its own fleet queue's admission, before any worker is chosen) | implemented |
| `lease.queued` | request id, queue position | no capacity; request entered the wait queue | LeaseAcquisitionCoordinator (worker) / FleetLeaseCoordinator (gateway) | implemented |
| `lease.granted` | lease id, device id, requester, request id, source (`warm`/`booted`/`provisioned`, ADR 0016 §2: the kind of the plan that granted it -- an eviction never grants by itself, so the plan made after it decides), `fleetRequestId` when the grant served a probe (ADR 0021 §3, additive) | a device was assigned and handed out | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.renewed` | lease id, new deadline | a `lease.renew` succeeded — whether it came from `simlock lease renew`, `POST /v1/leases/{id}/renew`, or the renew timer a running `simlock lease` / MCP session keeps over its own lease. There is one renew path and this is it | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.released` | lease id, device id, reason (explicit/killed/device-lost), owner id | an explicit `lease.release` (which is what a `simlock lease` holder does on its way out), (killed) an operator `release --all` or `nuke`, or (device-lost) a leased device could not be recovered after it stopped running outside simlock, or a daemon start found its device not running, and the device of that lease was wiped and returned to the pool, left waiting in `reclaiming` on a platform the daemon could not list, or marked missing. Closing a connection is not a release and never emits this | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.expired` | lease id, device id, owner id | the lease's deadline passed with no `lease.renew` behind it — the grant-time TTL, or the TTL of the last renew, simply ran out. This is the one way a lease ends without somebody asking, and the only bound on a holder that was killed outright | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.rejected` | request id, requester (both required on every reason, additive, ADR 0016 §2), request spec (as on `lease.requested`; `full` replaced by `mode`, ADR 0007 §13; `model` optional and `class` added, ADR 0015 §9; `osVersion` may be a range as typed, ADR 0015 §2), reason (timeout/no-wait/unresolvable-spec/no-worker/already-leased/lease-id-taken/boot-timeout/killed/cancelled/daemon-restarted/worker-failed), `code` and `worker` on `worker-failed` (ADR 0021 §4, additive; `worker`, never `workerId`, which marks a relayed event, ADR 0014 §6) | a request ended without a grant. A worker emits it only for its local requests; a probe ends in `lease.declined` there (ADR 0021 §2). A gateway emits it for every ending that is not a grant (ADR 0021 §4): its own reasons, `unresolvable-spec` for the last cannot-serve refusal whether or not the request had queued, and `worker-failed` for any other failure on the worker it went to -- a terminal refusal, a failure after progress, `WORKER_UNREACHABLE`, `INTERNAL`, a dispatch timeout, a worker's own `REQUESTER_ALREADY_LEASED` or `LEASE_ID_TAKEN` -- with `code` the error code the caller got and `worker` the worker. `dispose()` emits nothing, so a request still open when a gateway stops has no ending event (ADR 0021 §5 plans for usage to close those at the next `daemon.started`; not built yet). A request refused at admission (`killed`, `already-leased`, `lease-id-taken`) was never stored and has no `lease.requested` (except a gateway's `lease-id-taken` after a grant, below); it carries the id minted for it before the check, the one the stored request would have had; on a gateway (ADR 0009 §4, §8) `no-worker` is rows 1 and 5 of the fast-fail table (`NO_CAPACITY`: no worker takes requests, or none that does can serve it) and `unresolvable-spec` rows 2 to 4 (`NO_DRIVER`, `UNKNOWN_MODEL`, `RUNTIME_MISSING`), emitted in the dispatch walk before the request is queued, so a request rejected on arrival emits no `lease.queued`, and a waiting one is rejected when the views change (additive, events rule 6). A request a worker refused with one of those codes (ADR 0009 §5) and the table later ends with that stored refusal gets a gateway `unresolvable-spec`, whether or not it had entered the gateway queue (the worker only declined it, ADR 0021 §4); `daemon-restarted` is a request still waiting when the daemon stopped, settled as failed when it starts again (#72; widens a published vocabulary, which events rule 6 allows as additive). The reason list can grow: a consumer must tolerate a reason it does not know; `cancelled` is an explicit single-request cancel (`cancelPending` on the leasing module, backing `DELETE /v1/lease-requests/{id}`) of a still-queued waiter -- one with device work already in flight is reported `not-cancellable` instead, the same envelope the queue timeout already uses | LeaseAcquisitionCoordinator / WaitQueue / LeaseStartup (worker) / FleetLeaseCoordinator (gateway) | implemented |
| `lease.declined` | `{ requestId, fleetRequestId, requester, requestSpec, reason }` -- `reason` takes `lease.rejected`'s values; `requestSpec` is there for the same reason as on `lease.rejected`: a decline at admission has no `lease.requested` (ADR 0021 §2) | a worker refused or failed a probe, a `lease.request` carrying `fleetRequestId` (ADR 0021 §1), whatever the reason (`no-wait`, `unresolvable-spec`, `already-leased`, `lease-id-taken`, `boot-timeout`, `killed`, `daemon-restarted` at the next start) and however far the work got. The gateway owns the outcome of a probe, so the worker never rejects one and never queues one: where it would queue (a second failed provision) it declines with `no-wait` and answers `NO_CAPACITY`. The event depends only on the request being a probe, never on whether the gateway will retry. A local request is rejected exactly as before | LeaseAcquisitionCoordinator / WaitQueue / LeaseStartup (worker) | implemented |

On a **gateway**, `lease.requested`, `lease.queued` and `lease.rejected` are its own fleet queue's facts (ADR 0005 §11/§14),
emitted by `FleetLeaseCoordinator` and never by the worker whose device is
eventually granted — `lease.granted`/`renewed`/`released`/`expired` for a fleet
lease arrive already relayed from the owning worker (see "Fleet (gateway
mode)" below), so a gateway never emits those four itself. Every request a gateway ends while it runs has one ending of its own (ADR 0021 §4): `request.granted`, or `lease.rejected`. `already-leased`
on a gateway is the fleet-wide one-lease-per-requester check (§14, keyed on
`requesterId`), answered from the gateway's own lease index before any
worker is ever contacted. `lease-id-taken` (ADR 0020; widens a published vocabulary, which events rule 6 allows as additive) is a `leaseId` an active lease or a waiting request already holds; on a gateway it is the gateway's own leases and requests, checked the same way, and a worker's own refusal of it is that worker's `lease.declined` and, on the gateway, a `lease.rejected` with reason `worker-failed` and code `LEASE_ID_TAKEN` (ADR 0021 §4). A gateway also emits it when a grant arrives for a bare id its index already routes to another worker: the new worker's lease is released and the request ends with it.

## Capacity and queue

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `capacity.changed` | per platform (`ios`, `android`) and `global`: running, max running, reserved, warm; `ramBudget` (used bytes, limit bytes) only under the `resource` capacity strategy | a worker's capacity figures differ from the last ones emitted: after a registry commit, or after a provisioning or boot reservation is taken or released. Emitted once when the daemon has started, so every run begins with a step; two consecutive events never carry equal figures. The figures are the ones `simlock status` reports | CapacityObserver (worker) | implemented |
| `queue.changed` | depth | the number of requests waiting in a queue changed: a request joined it or left it. Emitted once when the daemon has started. A worker emits it for its own queue and a gateway for its fleet queue; a worker's events a gateway relays carry `workerId`, and the gateway's own do not | WaitQueue (worker) / FleetLeaseCoordinator (gateway) | implemented |
| `warm-pool.target-missed` | `{ platform, model, osVersion?, mode, count, ready, reason }` — `osVersion` is the resolved one, or the configured one for a target that did not resolve, and absent when it names none and did not resolve; `reason` is the one reason the pool records for the target (`warm-pool/policy.ts` for one that resolved, `warm-pool/converger.ts` for one the resolver refused), the one `short` carries in `status.get` (the one reason `simlock status` shows as the target's `short`, but never `disabled`, since a pool that is off reports no target: `no-driver`, `runtime-missing`, `unknown-model`, `unresolvable`, `boot-failed`, `device-limit`, `running-limit`, `reserve` or `ram-budget`) | a warm pool target went short: after a pass the pool could do nothing for a target that has fewer ready devices than its count, and it was not already missed (ADR 0017 §7). Emitted once the pass's actions have run (events rule 3), once per report on that edge (targets that resolve to one spec are one report and emit one event between them, with their counts added; each target the resolver refuses emits its own), not on each short pass after, nor when a retry or a boot fills it and it is short again; the edge is kept per configured target, and only ready devices reaching its count end the miss, so a target met in between and missed again emits again. A target that is filling, held by `warmPool.maxConcurrentBoots` or waiting behind a queued request is not short | WarmPool (worker) | implemented |

## Device lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `device.provisioned` | device id, spec (`mode: "slim"` for a device planned slim, absent for a full one -- the one place the planned mode is visible, ADR 0007 §9; `imageTag` for a device whose request named one, #214, additive), driver, duration | driver `provision` committed to registry | Registry | implemented |
| `device.ready` | device id, boot duration | readiness probe passed | Registry | implemented |
| `device.reclaimed` | device id, strategy (erase/snapshot/wipe), duration | fresh-state reclaim finished. Never emitted for a device created under `lease.identity` `fresh` (#75): nothing is reclaimed, the device is deleted instead | Registry | implemented |
| `device.purge-failed` | device id, lease id, attempted strategy (erase/snapshot/wipe/delete), duration, stable error summary | release-time purge failed (including the deferred wipe a daemon start runs in the background, ADR 0019 §2), or (strategy `delete`, #75) the shutdown or delete that ends a `fresh` device's lease failed; the device enters `quarantined` (see below) rather than rejoining the pool. `delete` widens a published vocabulary (events rule 6 allows additive changes): a consumer must tolerate a strategy it does not know | ReclaimCoordinator (strategy `delete`: ReclaimCoordinator's spent-device path) | implemented |
| `device.quarantined` | device id, max retries, next retry deadline | a device committed to `quarantined` — present in the registry, still counted as running, not eligible for a grant. Fires immediately after `device.purge-failed` for a release-time purge or delete failure (`reclaiming`/`shutdown → quarantined`), or on its own for a stalled-transition timeout (see `device.stalled-transition-detected`) | QuarantineCoordinator | implemented |
| `device.quarantine-recovered` | device id, attempts, reclaim strategy | a quarantined device's retried purge succeeded; it returned to `ready`/`shutdown` and rejoined the warm pool. Never emitted for a spent `fresh` device (`mayBeGranted` false): its retry is a delete, and a successful one emits `device.deleted` with initiator `lease-end` | QuarantineCoordinator | implemented |
| `device.quarantine-abandoned` | device id, attempts | a quarantined device exhausted its configured retry budget (`warmPool.quarantine.maxRetries`) — purge retries, or delete retries for a spent `fresh` device — and was destroyed | QuarantineCoordinator | implemented |
| `device.quarantine-stranded` | device id, attempts, stable error summary | a quarantined device exhausted its retry budget (purge or delete retries) and the destroy that should have retired it also failed; it stays `quarantined` with no further retry until an operator intervenes | QuarantineCoordinator | implemented |
| `device.shutdown` | device id, initiator (rule/command; `warm-pool` when the warm pool shut an idle device down, over the running limit, with `warmPool.enabled: false`, to keep `warmPool.reserveRunning` running slots free, or because a ready device that never served a lease and that no `warmPool.targets` entry keeps has been idle past `idle.shutdownAfterMs`) | device stopped, still on disk | Registry; ReclaimCoordinator for interrupted reclaim recovery | implemented |
| `device.deleted` | device id, initiator (`lease-end` when a `fresh` device's lease ended and its delete completed — from ReclaimCoordinator, at startup convergence, or retried from quarantine; #75. `doctor` when `doctor --fix` marked a missing device, or startup's lease reconciler found a leased device absent from a platform it could read and ended the lease in the same write, ADR 0019 §2) | device removed from disk and registry | Registry | implemented |
| `device.foreign-state-detected` | device id, platform, expected (running/stopped), observed (running/stopped) | doctor reconcile found a managed device's observed boot state disagreeing with the committed registry state | Doctor | implemented |
| `device.foreign-provenance-detected` | device id, platform, detail (erased/mark-mismatch/durable-mark-missing) | doctor reconcile found a managed device's provenance marks no longer proving Simlock owns it | Doctor | implemented |
| `device.stalled-transition-detected` | device id, platform, state (provisioning/reclaiming), age, threshold | doctor reconcile found a `provisioning`/`reclaiming` device whose time in that state exceeds a driver-derived threshold (`stalledTransition.thresholdMultiplier` over `Driver.estimate`, floored at `stalledTransition.minimumThresholdMs`) — the driver call meant to resolve the transition never did | Doctor | implemented |
| `device.crash-detected` | device id, lease id, platform, observed | a leased device was observed `stopped` for `health.stableObservations` consecutive ticks | LeaseHealthMonitor | implemented |
| `device.recovered` | device id, lease id, attempts, duration | a crashed leased device was rebooted under its existing lease and passed readiness | LeaseHealthMonitor | implemented |
| `device.recovery-failed` | device id, lease id, attempts, reason, error | recovery could not restore a leased device (absent from driver reality, provenance drift, or attempts exhausted) and its lease was released | LeaseHealthMonitor | implemented |
| `device.orphan-purged` | driver device id, platform, device root | `simlock doctor --purge-orphans` destroyed a device that sat inside a validly-marked Simlock device root with no registry record — see [ADR 0001](adr/0001-simlock-owned-device-roots.md) | Doctor | implemented |
| `device.slimmed` | device id, address, platform (ios), categories, label count, duration, signature, unknown labels | *after* the post-slim reboot's `bootstatus` succeeded -- i.e. once the `launchctl disable` overrides applied via `simctl spawn` are actually in force on the simulator | driver-diagnostics | implemented |

`device.slimmed` reports a fact committed to the *simulator's own launchd database*, not to the
Simlock registry (ADR 0002, `docs/internal/adr/0002-opt-in-slim-ios-simulators.md`) -- so events rule 3 ("emit post-commit
only") is satisfied by waiting for that commit to become observable, not by waiting on a registry
write: the driver applies the `launchctl disable` overrides, reboots the device, and only fires
`onSlimmed` once the second `bootstatus` has passed, proving the overrides survived the reboot and
are actually in force. The registry's own `device.ready` for that same boot is a separate,
later event, emitted through the normal readiness path once the driver call returns. A slim
request on a runtime older than iOS 18.5 is resolved to a full spec before planning (ADR 0007
§4), so it never reaches a slim pass. A *skipped* slim on a slim-spec device -- its runtime id
didn't parse, or the disable pass itself failed -- is deliberately not an event: it isn't a fact worth putting in front of every event-bus
consumer, just operator diagnostics, so it's a `warn` log line (`daemon.driver-discovery`) instead.

## Components

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `component.install-started` | platform, component id (the string the install was asked for: an iOS runtime version, `latest`, or a bare major; an Android API level), requester id (of the request that started the install, when known: a lease request's requester, or the principal that ran `component install`) | once per install, after the free-disk check passed and disk was set aside, just before `xcodebuild -downloadPlatform` / `sdkmanager --install` runs | component-installer | implemented |
| `component.installed` | platform, component id, version (the exact version now installed), already present (`true` when the installer ran and found the component already there), duration, requester id | once per install, when the installer finished **and** a fresh read confirmed the component — never on a bare exit 0 | component-installer | implemented |
| `component.install-failed` | platform, component id, duration, stable error summary, requester id | once per install, when it failed: the installer failed (a license retry included), it ran out of `downloads.timeoutMs`, the daemon stopped, the installer exited 0 but a fresh read could not confirm the component, or the component installed but its record could not be stored | component-installer | implemented |
| `component.removed` | platform, component id (the version the removal was asked for), version (the exact version removed), size in bytes (when it could be read), residue (when something stayed on disk: what, and how to reclaim it), requester id (the admin principal that ran `component remove`) | once per removal, after the platform's own removal (`simctl runtime delete` / `sdkmanager --uninstall`) finished, a fresh read confirmed the component is gone, and Simlock's record of installing it was deleted — never for a dry run or a refused removal | component-installer | implemented |

`ComponentInstaller` (`src/core/component-installer.ts`) is the only emitter (ADR 0010 §3):
drivers install but never emit (architecture rule 5). The events fire once per install, not
once per request that joined it, and only for an install that reached the driver -- a call
that ends as `already-installed` from `findComponent`, as not needed, or refused by the disk
reservation (`InsufficientDiskSpaceError`) emits nothing. `component.installed` is emitted after
the component record is committed to the registry (events rule 3); with `alreadyPresent: true`
nothing was recorded (ADR 0010 §5). `requesterId` is the requester whose call started the
install. See "Device requests" in [ARCHITECTURE.md](ARCHITECTURE.md) for how a missing
component gets to this point. The requester hears the install through its own `downloading`
progress stage, a direct call chain from the installer, not these events (architecture rule 5).

`component.removed` has the same single emitter (ADR 0010 §8). `ComponentInstaller.remove`
emits it after the driver's `removeComponent` returned and the component record was deleted
from the registry (events rule 3); a dry run, a refusal (`COMPONENT_NOT_OWNED`,
`COMPONENT_IN_USE`, `COMPONENT_BUSY`) and a driver failure emit nothing, and a failure keeps the
record. `requesterId` is the admin session's principal, never a caller-supplied id (safety rule
6). `residue` is the driver's text, carried unread: on iOS it names the never-used default-set
simulators the removal left unavailable and the asset-store download `simctl runtime delete`
left behind (#79), each when there is one.

## System

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `daemon.started` | version, config snapshot (`gateway.token`, when set, reads `[redacted]`: the payload reaches the ring and `events.jsonl`, which are not guarded like `config.json`; masked rather than dropped so the keys stay the same, #170) | daemon finished startup + reconcile | DaemonServer | implemented |
| `daemon.stopping` | reason | graceful shutdown began | DaemonServer | implemented |
| `disk.pressure-detected` | free bytes, threshold | free disk crossed under the configured threshold (edge-triggered: once per crossing, not once per tick while it persists) | CleanupReaper | implemented |
| `cleanup.executed` | rule name, action, target, reason | cleanup executor committed a proposed action | CleanupExecutor | implemented |
| `doctor.reconciled` | drift findings | daemon reconciliation completed | Doctor | implemented |
| `driver.root-rejected` | platform, root path, reason (not-absolute/missing-marker/invalid-marker/wrong-instance/symlink/wrong-owner/wrong-permissions/non-empty-unowned-root/unreadable) | a driver's device root failed ownership validation at startup, so that platform's driver did not start | DaemonServer | implemented |
| `driver.adb-server-rejected` | port, reason (occupied/start-failed/invalid-port) | Simlock's own adb server could not be established — the port was occupied by a server it does not own, the server it started never began listening, or the configured port is not usable — so the Android driver did not start | DaemonServer | implemented |

## Fleet (gateway mode)

These are the facts a daemon running as a **gateway** emits about the fleet
connected to it ([ADR 0005](adr/0005-gateway-and-worker-modes.md)). A worker
never emits them — it has no workers or fleet queue of its own — and a
gateway emits none of the device-lifecycle facts above on its own behalf,
because it owns no devices.

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `worker.connected` | worker id, label, worker's daemon version | a worker's uplink opened and its `hello` completed, so the gateway can drive it. A worker whose `hello` found no overlapping protocol range emits nothing: it is in the registry as `incompatible`, which is where an operator finds it | WorkerRegistry | implemented |
| `worker.rejected` | reason (`unauthenticated`/`forbidden`), worker id, label, occasionally a count | an uplink was turned away at the door, before any session existed: `unauthenticated` (`401`) for a missing or unrecognized join token — a revoked or mistyped one lands here — and `forbidden` (`403`) for a real token whose role is not `worker`. Version skew is deliberately not one of these: that uplink authenticated, so the worker enters the registry as `incompatible` and emits nothing (see the note below the table). A refused peer proves no identity, so `workerId` and `label` are only what the connection claimed and may be absent. `count`, present only above one, is how many identical (reason, claimed id) refusals the *previous* coalescing window absorbed — `GatewayService` computes it before calling into the registry, so a flood of refused dials collapses to one event per window rather than one per attempt, since the ring buffer they land in is bounded by count, not bytes | WorkerRegistry | implemented |
| `worker.disconnected` | worker id, label, lease count | a worker's uplink closed. `leaseCount` is what its view still shows it holding — how much is stranded, and why the view is kept rather than dropped, not ended: the gateway never guesses a lease is gone before the worker says so | WorkerRegistry | implemented |
| `worker.removed` | worker id, label, reason (operator/retention) | a disconnected worker's view was forgotten: by `simlock worker remove`, or because every gateway-issued lease on it had expired and `gateway.disconnectedRetentionMs` elapsed. Never emitted for a connected worker (`WORKER_CONNECTED` refuses that) | WorkerRegistry | implemented |
| `worker.drain-started` | worker id, label | `simlock worker drain` flagged a worker: it keeps its leases and receives no new dispatches | WorkerRegistry | implemented |
| `worker.drain-ended` | worker id, label | `simlock worker undrain` cleared that flag. Nothing else ends a drain: the flag lives in the gateway's persisted worker registry, so it survives both a worker reconnect and a gateway restart | WorkerRegistry | implemented |
| `request.dispatched` | `{ requestId, workerId, requesterId, platform, model?, class?, mode?, reason, stage, queuedMs }` — `model` is the exact model the request named and `class` the class it named; a request names at most one, and one naming neither carries neither (ADR 0015 §9); `mode` is the device mode the request named, `slim` or `full`, and absent when it named none (ADR 0009 §8); `reason` is the routing policy's own `warm-hit`/`free-capacity` distinction (ADR 0005 §13): `warm-hit` when the deciding stage is `warm-hit`, `free-capacity` otherwise; `stage` names the routing stage that decided (ADR 0009 §1, §8); `queuedMs` how long the request sat queued before this dispatch | the gateway's fleet queue sent a queued request to a worker with `noWait: true`, and the worker took it — the grant itself, or its first `progress` push, whichever arrives first (ADR 0005 §11: device work having started means the request is that worker's now). An immediate `NO_CAPACITY` is a stale view, not a dispatch, and emits nothing — the request stays queued, and that worker is not sent it again until its reported state changes (ADR 0009 §5); a `noWait` request fails with `NO_CAPACITY` instead, unless another worker takes it at once | FleetLeaseCoordinator | implemented |
| `request.granted` | `{ requestId, worker, leaseId, workerLeaseId }` -- `leaseId` is the gateway lease id and `workerLeaseId` the worker's; `worker`, never `workerId`, because `payload.workerId` marks a relayed event (ADR 0014 §6) | the gateway handed a fleet request's grant to its caller (ADR 0021 §4): after the lease index accepted it, and only if the waiter was still open. A grant given back for ADR 0020's mismatched id, one the lease index refused (the request ends in `lease-id-taken`), and one that lands after the waiter was settled (timeout, cancel, or the gateway stopping) emit nothing. A worker's push of this name is refused by the worker link (it is in `GATEWAY_OWN_EVENTS` with the six `worker.*` events; `request.dispatched` is not in that set) | FleetLeaseCoordinator | implemented |

Drain and undrain are idempotent, and an event is a fact about a *change*:
draining an already-drained worker succeeds and emits nothing.

`worker.rejected` exists because the alternative is silence (ADR 0005 §22): a
worker whose credential is refused produces no `worker.connected`, and
without this fact an operator staring at `simlock worker list` sees a machine
that simply never appears, with nothing anywhere to say why. It is
deliberately *not* a `worker.disconnected` with another reason — nothing
connected, so nothing disconnected, and a fact whose subject never existed
should not borrow the vocabulary of one that did.

**A protocol mismatch is neither of those.** That uplink presented a valid
join token and authenticated; what failed was `hello`'s range negotiation. So
the worker *does* enter the registry, with `state: "incompatible"` and both
ranges on its view, visible in `simlock worker list` — which is the whole
point, since that is the machine an operator has to go and upgrade. It is
simply never dispatched to, and no `worker.connected` follows, because
nothing usable connected. That is also why `incompatible` is not one of
`worker.disconnected`'s reasons: an incompatible worker was never a connected
worker to lose.

**A relayed event keeps the worker's `id` and `timestamp`** (ADR 0014 §2, §5,
§6). A gateway republishes a worker's business events through the bus's
`republish`, whose only caller is the worker link: it mints `seq` and nothing
else, so one fact has one `id` in the worker's event file, the gateway's, both
rings and both streams, and the two files can be joined by it.
`payload.workerId` is the only mark of a relay; nothing is added to the
envelope. A relayed line's time is when the fact happened on the worker, so a
worker's clock skew shows in the gateway's order, and `--since` on the gateway
filters by that time. `simlock events`, `events.replay`, `GET /v1/events` and
the console's buffer present a replay by `timestamp`, then `seq`;
`simlock events --follow` prints live pushes, and the pushes buffered during its
replay, in arrival order, so a relayed event from a worker whose clock is behind
prints after a later gateway event. A worker's `id` and
`timestamp` are claims, bounded by the push schema before the relay sees them: the
`id` by its pattern, the `timestamp` to the range a JavaScript date holds
(|t| <= 8.64e15 ms), so no value the console cannot render as a date reaches the
gateway's bus or event file.

**`device.exec` emits no event, and that is deliberate.** It is the one
operation here with no fact of its own. Running a command against a device is
not a state change simlock owns — the lease that authorizes it already
emitted `lease.granted`, the device's own state is untouched, and a fleet
where every `adb shell input tap` produced a bus event would push everything
else out of a 1000-entry ring buffer within minutes. An audit trail of what
agents ran on their devices is a different feature with different retention
needs, not a line in this catalogue.

**Every worker's own business events are republished on the gateway's bus**
with `workerId` added to the payload, under their original names and with
their original emitting module — the fact happened in that worker's lease
engine or reaper, and rewriting either would make the audit trail lie about
where. That is what makes `simlock events` and `simlock events --follow`
against a gateway a fleet-wide view (`lease.granted`, `device.ready`,
`cleanup.executed`, and the rest, each naming the machine it happened on),
and it is the one place a payload documented above arrives with an extra
field: additive, and only ever on a gateway. The eight events in this
section's own table are the gateway's own, and carry no `workerId` beyond
the worker they are about.

Relayed events are written to the gateway's own event file
(`events.jsonl`) along with its own, so `simlock events --since` against a
gateway reaches back across a gateway restart. Two consequences of relaying
rather than owning: the gateway's history only holds what arrived while its
uplinks were up (a worker's events from before it connected are not
backfilled), and a worker's own
`simlock events` keeps showing exactly what it always did, un-prefixed and
unaware that anything is watching.

A relayed `lease.expired`/`lease.released`/`device.crash-detected`/
`device.recovered` names the *worker's own* lease id in its payload, not the
gateway's — `GatewayOwnerRoutedFacts` (the gateway's `OwnerRoutedFacts`) is
what resolves the gateway's own lease id, and the `ownerId` to route the
corresponding `lease-lost`/`device-unhealthy`/`device-recovered` push by,
from the fleet lease index rather than the relayed payload directly. The
payload's own `ownerId` is correct for a worker's own local lease (the
worker never had a reason to touch it), but for a gateway-issued one it is
whatever that worker echoed back of what the gateway forwarded when it
granted the lease (ADR §27a) — round-tripped through a machine this gateway
does not control, not a value it minted itself, so it is resolved from the
index (which recorded the real answer at grant time) rather than trusted
verbatim off the wire.

## Conventions recap

- Every event carries: `id` (`evt_` and a unique suffix; it names the event for
  good and survives a daemon restart), `seq`, `timestamp`, `event`, `payload`,
  emitting module.
- The `id` arrived with protocol 10. Lines already in `events.jsonl` from before
  the upgrade have none and are not shown by `simlock events --since`.
- Events are appended to an in-memory ring buffer, which `simlock events`
  without `--since` replays, and to the event file `~/.simlock/events.jsonl`,
  one JSON line per event with the same fields. The file survives daemon
  restarts and crashes, is what `simlock events --since` reads, and is the
  durable record: no event is copied into `daemon.log`. It is kept for
  `eventLog.retention` (seven days), bounded by `eventLog.maxBytes`, in numbered
  generations of `eventLog.rotateBytes` each. See ADR 0006 and ADR 0016.

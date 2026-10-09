# Events

Catalog of business events carried on the daemon's event bus, exposed
through `simlock events` and `simlock events --follow`.

> Status: **planned catalog** — the Status column reflects what has shipped.

## Lease lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `lease.requested` | request id, request spec (platform, model when the request named one, device class when the request named one, os version, as an exact version or a range as typed, device mode when the request named one, image tag when the request named one), requester, wait policy, the gateway's request id as `fleetRequestId` when the request is a gateway's dispatch to this worker | a lease request is accepted by the daemon and stored; the request id is the stored request's, so an observer can match this event to it | LeaseAcquisitionCoordinator (worker) / FleetLeaseCoordinator (gateway — its own fleet queue's admission, before any worker is chosen) | implemented |
| `lease.queued` | request id, queue position | no capacity; request entered the wait queue | LeaseAcquisitionCoordinator (worker) / FleetLeaseCoordinator (gateway) | implemented |
| `lease.granted` | lease id, device id, requester, request id (the `lease.requested` it answers), source (`warm`: a ready device handed over; `booted`: a shut-down device booted for it; `provisioned`: a device created for it), `fleetRequestId` when it served a gateway's dispatch | a device was assigned and handed out | LeaseLifecycle | implemented |
| `lease.renewed` | lease id, new deadline | a `lease.renew` succeeded — whether it came from `simlock lease renew`, `POST /v1/leases/{id}/renew`, or the renew timer a running `simlock lease` / MCP session keeps over its own lease. There is one renew path and this is it | LeaseLifecycle | implemented |
| `lease.released` | lease id, device id, reason (explicit/killed/device-lost), owner id | an explicit `lease.release` (which is what a `simlock lease` holder does on its way out), (killed) an operator `release --all` or `nuke`, or (device-lost) a leased device could not be recovered after it stopped running outside simlock, or a daemon start found its device not running, and the device of that lease was wiped and returned to the pool, left waiting in `reclaiming` on a platform the daemon could not list, or marked missing. Closing a connection is not a release and never emits this | LeaseLifecycle | implemented |
| `lease.expired` | lease id, device id, owner id | the lease's deadline passed with no `lease.renew` behind it — the grant-time TTL, or the TTL of the last renew, simply ran out. This is the one way a lease ends without somebody asking, and the only bound on a holder that was killed outright | LeaseLifecycle | implemented |
| `lease.rejected` | request id, requester, request spec (as on `lease.requested`: a request that named a class or nothing has no model, and one that named an OS range carries it as typed), reason (timeout/no-wait/unresolvable-spec/no-worker/already-leased/lease-id-taken/boot-timeout/killed/cancelled/daemon-restarted/worker-failed), and for `worker-failed` also `code` and `worker` | a request ended without a grant. A worker emits it only for its own, local requests: a request a gateway sent it ends in `lease.declined` there instead. A request refused before it was stored (`killed`, `already-leased`, `lease-id-taken`) emits no `lease.requested`, and its `lease.rejected` carries the id it would have been stored under (on a gateway, `lease-id-taken` can also end a request that was stored, when a worker's grant carries an ID the gateway already routes elsewhere: that one has its `lease.requested`); on a gateway, `no-worker` is a request no worker that takes requests can serve, `NO_CAPACITY` at once, and `unresolvable-spec` is one no known worker has the platform, model, or runtime for, and such a request emits no `lease.queued`. A request a worker refused as unable to serve (`RUNTIME_MISSING`, `UNKNOWN_MODEL`, `NO_DRIVER`) while another worker was busy waits in the gateway queue, unless it is a `noWait` request, which is rejected at once with reason `no-wait` and emits no `lease.queued`; a request that finds no worker left emits `unresolvable-spec`, after its `lease.queued` when it had queued; `worker-failed` is a request that failed on the worker it went to (a refusal that is final, a failure after the worker began work, an unreachable worker, or a dispatch that timed out), with `code` the error code the caller got and `worker` the worker's id; `daemon-restarted` is a request still waiting when the daemon stopped, settled as failed when it starts again. The reason list can grow: a consumer must tolerate a reason it does not know; `cancelled` is an explicit single-request cancel (backing `DELETE /v1/lease-requests/{id}`) of a still-queued waiter — one with device work already in flight is reported `not-cancellable` instead, the same envelope the queue timeout already uses | LeaseAcquisitionCoordinator / WaitQueue / LeaseStartup (worker) / FleetLeaseCoordinator (gateway) | implemented |
| `lease.declined` | request id, gateway request id (`fleetRequestId`), requester, request spec (as on `lease.rejected`), reason (the values of `lease.rejected`) | a worker refused or failed a request a gateway sent it, for any reason and however far the work got. The gateway owns that request's outcome and may try another worker, so the worker declines rather than rejects, and never queues such a request. A worker that was asked and has no room declines with `no-wait`; one that cannot serve the request, or fails it, declines with the reason it would have rejected a local request with. A request still open when the worker stopped is declined with `daemon-restarted` at the next start | LeaseAcquisitionCoordinator / WaitQueue / LeaseStartup (worker) | implemented |

On a **gateway**, `lease.requested`, `lease.queued` and `lease.rejected` are its own fleet queue's facts,
emitted by `FleetLeaseCoordinator` and never by the worker whose device is
eventually granted — `lease.granted`/`renewed`/`released`/`expired` for a fleet
lease arrive already relayed from the owning worker (see "Fleet (gateway
mode)" below), so a gateway never emits those four itself. Every request a gateway ends while it runs has one ending of its own in the gateway's history: `request.granted` when it hands the grant to its caller, or `lease.rejected` for any other ending. A request the gateway moves from one worker to another leaves a `lease.declined` on each worker that refused it, and no rejection. `already-leased`
on a gateway is the fleet-wide one-lease-per-requester check, answered from
the gateway's own lease index before any worker is ever contacted. `lease-id-taken` is a `leaseId` an active lease or a waiting request already holds; on a gateway it is the gateway's own leases and requests, checked the same way, and a worker's own refusal of it ends the request in a gateway `lease.rejected` with reason `worker-failed` and code `LEASE_ID_TAKEN`, beside the worker's `lease.declined`.

## Capacity and queue

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `capacity.changed` | per platform (`ios`, `android`) and `global`: running, max running, reserved, warm; `ramBudget` (used bytes, limit bytes) only under the `resource` capacity strategy | a worker's capacity figures differ from the last ones emitted: after a registry commit, or after a provisioning or boot reservation is taken or released. Emitted once when the daemon has started, so every run begins with a step; two consecutive events never carry equal figures. The figures are the ones `simlock status` reports | CapacityObserver (worker) | implemented |
| `queue.changed` | depth | the number of requests waiting in a queue changed: a request joined it or left it. Emitted once when the daemon has started. A worker emits it for its own queue and a gateway for its fleet queue; a worker's events a gateway relays carry `workerId`, and the gateway's own do not | WaitQueue (worker) / FleetLeaseCoordinator (gateway) | implemented |
| `warm-pool.target-missed` | platform, model, OS version (the one the target resolved to, or the one it names when it did not resolve; absent when it names none and did not resolve), mode, count, ready, reason (the one reason `simlock status` shows as the target's `short`: `no-driver`, `runtime-missing`, `unknown-model`, `unresolvable`, `boot-failed`, `device-limit`, `running-limit`, `reserve` or `ram-budget`) | a warm pool target went short: after a pass the pool could do nothing for a target that has fewer ready devices than its count, and it was not already missed. Once on that edge for each kind of device the targets name (targets that resolve to the same device emit one event between them, with their counts added), not on each short pass after, nor when a retry or a boot fills it and it is short again; only a target whose ready devices reach its count and that is then missed again emits again. A target that is filling, held by `warmPool.maxConcurrentBoots` or waiting behind a queued request is not short | WarmPool (worker) | implemented |

## Device lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `device.provisioned` | device id, spec (platform, model, os version, `mode: "slim"` for a device planned slim, and `imageTag` for a device whose request named one), driver, duration | driver `provision` committed to registry | Registry | implemented |
| `device.ready` | device id, boot duration | readiness probe passed | Registry | implemented |
| `device.reclaimed` | device id, strategy (erase/snapshot/wipe), duration | fresh-state reclaim finished. Never emitted for a device created under `lease.identity` `fresh`: nothing is reclaimed, the device is deleted instead | Registry | implemented |
| `device.purge-failed` | device id, lease id, attempted strategy (erase/snapshot/wipe/delete), duration, stable error summary | release-time purge failed (including the wipe of a device a daemon start put off), or (strategy `delete`) the shutdown or delete that ends a `fresh` device's lease failed; the device enters `quarantined` (see below) rather than rejoining the pool. The strategy list can grow: a consumer must tolerate a strategy it does not know | Reclaim coordinator | implemented |
| `device.quarantined` | device id, max retries, next retry deadline | a device committed to `quarantined` — present in the registry, still counted as running, not eligible for a grant. Fires immediately after `device.purge-failed` for a release-time purge or delete failure, or on its own for a stalled-transition timeout (see `device.stalled-transition-detected`) | QuarantineCoordinator | implemented |
| `device.quarantine-recovered` | device id, attempts, reclaim strategy | a quarantined device's retried purge succeeded; it returned to `ready`/`shutdown` and rejoined the warm pool. Never emitted for a `fresh` device: its retry is a delete, and a successful one emits `device.deleted` | QuarantineCoordinator | implemented |
| `device.quarantine-abandoned` | device id, attempts | a quarantined device exhausted its configured retry budget (`warmPool.quarantine.maxRetries`) — purge retries, or delete retries for a `fresh` device — and was destroyed | QuarantineCoordinator | implemented |
| `device.quarantine-stranded` | device id, attempts, stable error summary | a quarantined device exhausted its retry budget (purge or delete retries) and the destroy that should have retired it also failed; it stays `quarantined` with no further retry until an operator intervenes | QuarantineCoordinator | implemented |
| `device.shutdown` | device id, initiator (rule/command; `warm-pool` when the warm pool shut an idle device down, over the running limit, with `warmPool.enabled: false`, to keep `warmPool.reserveRunning` running slots free, or because a ready device that never served a lease and that no `warmPool.targets` entry keeps has been idle past `idle.shutdownAfterMs`) | device stopped, still on disk | Registry; the reclaim coordinator for interrupted reclaim recovery | implemented |
| `device.deleted` | device id, initiator (`lease-end` when a `fresh` device's lease ended and its delete completed, including a delete retried from quarantine; `doctor` when `doctor --fix`, or a daemon start that found a leased device gone from its platform, marked it missing) | device removed from disk and registry | Registry | implemented |
| `device.foreign-state-detected` | device id, platform, expected (running/stopped), observed (running/stopped) | doctor reconcile found a managed device's observed boot state disagreeing with the committed registry state | Doctor | implemented |
| `device.foreign-provenance-detected` | device id, platform, detail (erased/mark-mismatch/durable-mark-missing) | doctor reconcile found a managed device's provenance marks no longer proving Simlock owns it | Doctor | implemented |
| `device.stalled-transition-detected` | device id, platform, state (provisioning/reclaiming), age, threshold | doctor reconcile found a `provisioning`/`reclaiming` device whose time in that state exceeds a driver-derived threshold — the driver call meant to resolve the transition never did | Doctor | implemented |
| `device.crash-detected` | device id, lease id, platform, observed | a leased device was observed `stopped` for several consecutive health checks | LeaseHealthMonitor | implemented |
| `device.recovered` | device id, lease id, attempts, duration | a crashed leased device was rebooted under its existing lease and passed readiness | LeaseHealthMonitor | implemented |
| `device.recovery-failed` | device id, lease id, attempts, reason, error | recovery could not restore a leased device (absent from driver reality, provenance drift, or attempts exhausted) and its lease was released | LeaseHealthMonitor | implemented |
| `device.orphan-purged` | driver device id, platform, device root | `simlock doctor --purge-orphans` destroyed a device that sat inside a validly-marked Simlock device root with no registry record | Doctor | implemented |
| `device.slimmed` | device id, address, platform (ios), categories, label count, duration, signature, unknown labels | after the post-slim reboot succeeded, i.e. once the overrides that disable a set of iOS launchd services are confirmed in force on the simulator | driver-diagnostics | implemented |

A slim request on a runtime that cannot be slimmed is planned as a full
device from the start, so it never reaches a slim pass and produces no
`device.slimmed`. A slim pass that did not take (a failed disable pass) is
deliberately not an event — it's operator diagnostics, not a fact worth
putting in front of every event-bus consumer.

## Components

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `component.install-started` | platform, component id (the string the install was asked for: an iOS runtime version, `latest`, or a bare major; an Android API level), requester id (of the request that started the install, when known: a lease request's requester, or the principal that ran `component install`) | once per install, after the free-disk check passed and disk was set aside, just before `xcodebuild -downloadPlatform` / `sdkmanager --install` runs | component-installer | implemented |
| `component.installed` | platform, component id, version (the exact version now installed), already present (`true` when the installer ran and found the component already there), duration, requester id | once per install, when the installer finished **and** a fresh read confirmed the component — never on a bare exit 0 | component-installer | implemented |
| `component.install-failed` | platform, component id, duration, stable error summary, requester id | once per install, when it failed: the installer failed (a license retry included), it ran out of `downloads.timeoutMs`, the daemon stopped, the installer exited 0 but a fresh read could not confirm the component, or the component installed but its record could not be stored | component-installer | implemented |
| `component.removed` | platform, component id (the version the removal was asked for), version (the exact version removed), size in bytes (when it could be read), residue (when something stayed on disk: what, and how to reclaim it), requester id (the admin principal that ran `component remove`) | once per removal, after the platform's own removal (`simctl runtime delete` / `sdkmanager --uninstall`) finished, a fresh read confirmed the component is gone, and Simlock's record of installing it was deleted — never for a dry run or a refused removal | component-installer | implemented |

These fire once per install, however many requests joined it. A request that
needs no install emits none: one whose component turned out to be installed
already, one another install made unnecessary while it waited, or one refused
for lack of disk before anything started.

`component.removed` fires once per removal. A removal that is refused, or
that fails, emits nothing, and the component stays installed.

## System

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `daemon.started` | version, config snapshot (`gateway.token`, when set, reads `[redacted]`) | daemon finished startup + reconcile | DaemonServer | implemented |
| `daemon.stopping` | reason | graceful shutdown began | DaemonServer | implemented |
| `disk.pressure-detected` | free bytes, threshold | free disk crossed under the configured threshold (edge-triggered: once per crossing, not once per tick while it persists) | CleanupReaper | implemented |
| `cleanup.executed` | rule name, action, target, reason | cleanup executor committed a proposed action | CleanupExecutor | implemented |
| `doctor.reconciled` | drift findings | daemon reconciliation completed | Doctor | implemented |
| `driver.root-rejected` | platform, root path, reason (not-absolute/missing-marker/invalid-marker/wrong-instance/symlink/wrong-owner/wrong-permissions/non-empty-unowned-root/unreadable) | a driver's device root failed ownership validation at startup, so that platform's driver did not start | DaemonServer | implemented |
| `driver.adb-server-rejected` | port, reason (occupied/start-failed/invalid-port) | Simlock's own adb server could not be established — the port was occupied by a server it does not own, the server it started never began listening, or the configured port is not usable — so the Android driver did not start | DaemonServer | implemented |

## Fleet (gateway mode)

These are the facts a daemon running as a **gateway** emits about the fleet
connected to it. A worker never emits them — it has no workers or fleet
queue of its own — and a gateway emits none of the device-lifecycle facts
above on its own behalf, because it owns no devices.

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `worker.connected` | worker id, label, worker's daemon version | a worker's uplink opened and its `hello` completed, so the gateway can drive it. A worker whose `hello` found no overlapping protocol range emits nothing: it is in the registry as `incompatible`, which is where an operator finds it | WorkerRegistry | implemented |
| `worker.rejected` | reason (unauthenticated/forbidden), worker id, label, occasionally a count | an uplink was turned away at the door, before any session existed: `unauthenticated` (401) for a missing or unrecognized join token, `forbidden` (403) for a real token whose role is not `worker`. Version skew is deliberately not one of these: that uplink authenticated, so the worker enters the registry as `incompatible` and emits nothing. `count`, present only above one, is how many identical refusals a coalescing window absorbed | WorkerRegistry | implemented |
| `worker.disconnected` | worker id, label, lease count | a worker's uplink closed. `leaseCount` is what its view still shows it holding — how much is stranded, and why the view is kept rather than dropped: the gateway never guesses a lease is gone before the worker says so | WorkerRegistry | implemented |
| `worker.removed` | worker id, label, reason (operator/retention) | a disconnected worker's view was forgotten: by `simlock worker remove`, or because every lease on it had expired and `gateway.disconnectedRetentionMs` elapsed. Never emitted for a connected worker | WorkerRegistry | implemented |
| `worker.drain-started` | worker id, label | `simlock worker drain` flagged a worker: it keeps its leases and receives no new dispatches | WorkerRegistry | implemented |
| `worker.drain-ended` | worker id, label | `simlock worker undrain` cleared that flag. The flag lives in the gateway's persisted worker registry, so it survives both a worker reconnect and a gateway restart | WorkerRegistry | implemented |
| `request.dispatched` | request id, worker id, requester id, platform, model when the request named one, device class when the request named one, the mode when the request named one, reason (warm-hit/free-capacity), the routing stage that decided, queued duration | the gateway's fleet queue sent a queued request to a worker, and the worker took it — the grant itself, or its first `progress` push, whichever arrives first. An immediate `NO_CAPACITY` is a stale view, not a dispatch, and emits nothing — the request stays queued, and that worker is not sent it again until its reported state changes; a `--no-wait` request fails with `NO_CAPACITY` instead, unless another worker takes it at once | FleetLeaseCoordinator | implemented |
| `request.granted` | request id, worker (the worker's id), lease id (the gateway's), worker lease id | the gateway handed a fleet request's grant to its caller: the grant arrived from a worker, the gateway indexed it, and the request was still waiting. A grant given back, refused because the lease ID is already routed elsewhere, or arriving after the request ended (a timeout, a cancel, or the gateway stopping) emits nothing. The field is `worker`, never `workerId`: only a relayed event carries `workerId` | FleetLeaseCoordinator | implemented |

Drain and undrain are idempotent, and an event is a fact about a *change*:
draining an already-drained worker succeeds and emits nothing.

`worker.rejected` exists because the alternative is silence: a worker whose
credential is refused produces no `worker.connected`, and without this fact
an operator staring at `simlock worker list` sees a machine that simply
never appears, with nothing anywhere to say why. It is deliberately *not* a
`worker.disconnected` with another reason — nothing connected, so nothing
disconnected.

**A protocol mismatch is neither of those.** That uplink presented a valid
join token and authenticated; what failed was `hello`'s range negotiation.
So the worker *does* enter the registry, with `state: "incompatible"` and
both ranges on its view, visible in `simlock worker list` — which is the
whole point, since that is the machine an operator has to go and upgrade.
It is simply never dispatched to, and no `worker.connected` follows.

**`device.exec` emits no event, and that is deliberate.** Running a command
against a device is not a state change simlock owns — the lease that
authorizes it already emitted `lease.granted`, the device's own state is
untouched, and a fleet where every `adb shell` command produced a bus event
would push everything else out of the ring buffer within minutes.

**Every worker's own business events are republished on the gateway's bus**
with `workerId` added to the payload, under their original names — the fact
happened in that worker's lease handling or reaper, and rewriting either would
make the audit trail lie about where. That is what makes `simlock events`
and `simlock events --follow` against a gateway a fleet-wide view
(`lease.granted`, `device.ready`, `cleanup.executed`, and the rest, each
naming the machine it happened on), and it is the one place a payload
documented above arrives with an extra field: additive, and only ever on a
gateway. The events in this section's own table are the gateway's own, and
carry no `workerId` beyond the worker they are about.

A relayed event keeps the worker's `id` and `timestamp`. Its `payload.workerId`
is the only mark that it was relayed, and `seq` is the gateway's own. So the
same fact has the same `id` in the worker's `events.jsonl` and the gateway's,
and you can join the two files by it. A relayed line's time is when the fact
happened on the worker, not when the gateway heard it: a worker whose clock
runs ahead or behind the gateway's shows that skew in the gateway's order.
A replay (`simlock events`, `--since`, `GET /v1/events`, the console's buffer)
lists events by `timestamp`, then by `seq`; `simlock events --follow` prints
each live push as it arrives, so a relayed event from a worker whose clock is
behind prints after a later gateway event. A worker event whose `timestamp` is
not a time a date can hold (beyond 8.64e15 ms either side of the epoch) is not
relayed.

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
gateway's — the gateway resolves the `ownerId` to route the corresponding
`lease-lost`/`device-unhealthy`/`device-recovered` push from its own fleet
lease index, rather than trusting the relayed payload's `ownerId` verbatim.

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
  `eventLog.retention`, bounded in size by `eventLog.maxBytes`, in numbered
  generations of `eventLog.rotateBytes` each.

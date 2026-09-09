# Events

Catalog of business events carried on the daemon's event bus, exposed
through `simlock events` and `simlock events --follow`.

> Status: **planned catalog** — the Status column reflects what has shipped.

## Lease lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `lease.requested` | request spec, requester, wait policy | a lease request is accepted by the daemon | LeaseAcquisitionCoordinator (worker) / FleetLeaseCoordinator (gateway — its own fleet queue's admission, before any worker is chosen) | implemented |
| `lease.queued` | request id, queue position | no capacity; request entered the wait queue | LeaseAcquisitionCoordinator (worker) / FleetLeaseCoordinator (gateway) | implemented |
| `lease.granted` | lease id, device id, requester | a device was assigned and handed out | LeaseLifecycle | implemented |
| `lease.renewed` | lease id, new deadline | a `lease.renew` succeeded — whether it came from `simlock lease renew`, `POST /v1/leases/{id}/renew`, or the renew timer a running `simlock lease` / MCP session keeps over its own lease. There is one renew path and this is it | LeaseLifecycle | implemented |
| `lease.released` | lease id, device id, reason (explicit/killed/device-lost), owner id | an explicit `lease.release` (which is what a `simlock lease` holder does on its way out), (killed) an operator `release --all` or `nuke`, or (device-lost) a leased device could not be recovered after it stopped running outside simlock. Closing a connection is not a release and never emits this | LeaseLifecycle | implemented |
| `lease.expired` | lease id, device id, owner id | the lease's deadline passed with no `lease.renew` behind it — the grant-time TTL, or the TTL of the last renew, simply ran out. This is the one way a lease ends without somebody asking, and the only bound on a holder that was killed outright | LeaseLifecycle | implemented |
| `lease.rejected` | request spec, reason (timeout/no-wait/unresolvable-spec/already-leased/boot-timeout/killed/cancelled) | a request ended without a grant; `cancelled` is an explicit single-request cancel (backing `DELETE /v1/lease-requests/{id}`) of a still-queued waiter — one with device work already in flight is reported `not-cancellable` instead, the same envelope the queue timeout already uses | LeaseAcquisitionCoordinator / WaitQueue (worker) / FleetLeaseCoordinator (gateway) | implemented |

On a **gateway**, the first three of these are its own fleet queue's facts,
emitted by `FleetLeaseCoordinator` and never by the worker whose device is
eventually granted — `lease.granted`/`renewed`/`released`/`expired` for a fleet
lease arrive already relayed from the owning worker (see "Fleet (gateway
mode)" below), so a gateway never emits those four itself. `already-leased`
on a gateway is the fleet-wide one-lease-per-requester check, answered from
the gateway's own lease index before any worker is ever contacted.

## Device lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `device.provisioned` | device id, spec, driver, duration | driver `provision` committed to registry | Registry | implemented |
| `device.ready` | device id, boot duration | readiness probe passed | Registry | implemented |
| `device.reclaimed` | device id, strategy (erase/snapshot/wipe), duration | fresh-state reclaim finished | Registry | implemented |
| `device.purge-failed` | device id, lease id, attempted strategy, duration, stable error summary | release-time purge failed; the device enters `quarantined` (see below) rather than rejoining the pool | WarmPoolCoordinator | implemented |
| `device.quarantined` | device id, max retries, next retry deadline | a device committed to `quarantined` — present in the registry, still counted as running, not eligible for a grant. Fires immediately after `device.purge-failed` for a release-time purge failure, or on its own for a stalled-transition timeout (see `device.stalled-transition-detected`) | QuarantineCoordinator | implemented |
| `device.quarantine-recovered` | device id, attempts, reclaim strategy | a quarantined device's retried purge succeeded; it returned to `ready`/`shutdown` and rejoined the warm pool | QuarantineCoordinator | implemented |
| `device.quarantine-abandoned` | device id, attempts | a quarantined device exhausted its configured retry budget (`warmPool.quarantine.maxRetries`) and was destroyed | QuarantineCoordinator | implemented |
| `device.quarantine-stranded` | device id, attempts, stable error summary | a quarantined device exhausted its retry budget and the destroy that should have retired it also failed; it stays `quarantined` with no further retry until an operator intervenes | QuarantineCoordinator | implemented |
| `device.shutdown` | device id, initiator (rule/command) | device stopped, still on disk | Registry; WarmPoolCoordinator for interrupted reclaim recovery | implemented |
| `device.deleted` | device id, initiator | device removed from disk and registry | Registry | implemented |
| `device.foreign-state-detected` | device id, platform, expected (running/stopped), observed (running/stopped) | doctor reconcile found a managed device's observed boot state disagreeing with the committed registry state | Doctor | implemented |
| `device.foreign-provenance-detected` | device id, platform, detail (erased/mark-mismatch/durable-mark-missing) | doctor reconcile found a managed device's provenance marks no longer proving Simlock owns it | Doctor | implemented |
| `device.stalled-transition-detected` | device id, platform, state (provisioning/reclaiming), age, threshold | doctor reconcile found a `provisioning`/`reclaiming` device whose time in that state exceeds a driver-derived threshold — the driver call meant to resolve the transition never did | Doctor | implemented |
| `device.crash-detected` | device id, lease id, platform, observed | a leased device was observed `stopped` for several consecutive health checks | LeaseHealthMonitor | implemented |
| `device.recovered` | device id, lease id, attempts, duration | a crashed leased device was rebooted under its existing lease and passed readiness | LeaseHealthMonitor | implemented |
| `device.recovery-failed` | device id, lease id, attempts, reason, error | recovery could not restore a leased device (absent from driver reality, provenance drift, or attempts exhausted) and its lease was released | LeaseHealthMonitor | implemented |
| `device.orphan-purged` | driver device id, platform, device root | `simlock doctor --purge-orphans` destroyed a device that sat inside a validly-marked Simlock device root with no registry record | Doctor | implemented |
| `device.slimmed` | device id, address, platform (ios), categories, label count, duration, signature, unknown labels | after the post-slim reboot succeeded, i.e. once the overrides that disable a set of iOS launchd services are confirmed in force on the simulator | driver-diagnostics | implemented |

A *skipped* slim (an older runtime, a runtime id that didn't parse, or a
failed disable pass) is deliberately not an event — it's operator
diagnostics, not a fact worth putting in front of every event-bus consumer.

## Components

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `component.install-started` | platform, component id (iOS runtime version or "latest"; Android `sdkmanager` package name), requester id (when the triggering resolution knew one) | a driver is about to run `xcodebuild -downloadPlatform` / `sdkmanager --install` for a missing component, disk preflight already passed | driver-diagnostics | implemented |
| `component.installed` | platform, component id, duration, requester id | the install succeeded **and** a post-install re-scan confirmed the component the request actually needed is present (paired with the requested device type, for iOS) — never fired on a bare exit-0 | driver-diagnostics | implemented |
| `component.install-failed` | platform, component id, duration, stable error summary, requester id | the install failed, including a license-retry failure (exactly one `install-failed` per attempted install, never one per retry), **or** the installer exited 0 but the post-install re-scan could not confirm the component | driver-diagnostics | implemented |

A disk-preflight failure happens before any diagnostic fires: no install was
attempted, so nothing is reported as started or failed. The requester's own
progress stream does not yet reflect an in-flight download.

## System

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `daemon.started` | version, config snapshot | daemon finished startup + reconcile | DaemonServer | implemented |
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
| `request.dispatched` | request id, worker id, requester id, platform, model, reason (warm-hit/free-capacity), queued duration | the gateway's fleet queue sent a queued request to a worker, and the worker took it — the grant itself, or its first `progress` push, whichever arrives first. An immediate `NO_CAPACITY` is a stale view, not a dispatch, and emits nothing — the request stays queued and is retried on the next pass | FleetLeaseCoordinator | implemented |

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
happened in that worker's lease engine or reaper, and rewriting either would
make the audit trail lie about where. That is what makes `simlock events`
and `simlock events --follow` against a gateway a fleet-wide view
(`lease.granted`, `device.ready`, `cleanup.executed`, and the rest, each
naming the machine it happened on), and it is the one place a payload
documented above arrives with an extra field: additive, and only ever on a
gateway. The events in this section's own table are the gateway's own, and
carry no `workerId` beyond the worker they are about.

Two consequences of relaying rather than owning: the gateway's ring buffer
only holds what arrived while its uplinks were up (a worker's events from
before it connected are not backfilled), and a worker's own
`simlock events` keeps showing exactly what it always did, un-prefixed and
unaware that anything is watching.

A relayed `lease.expired`/`lease.released`/`device.crash-detected`/
`device.recovered` names the *worker's own* lease id in its payload, not the
gateway's — the gateway resolves the `ownerId` to route the corresponding
`lease-lost`/`device-unhealthy`/`device-recovered` push from its own fleet
lease index, rather than trusting the relayed payload's `ownerId` verbatim.

## Conventions recap

- Every event carries: `timestamp`, `event`, `payload`, emitting module.
- Events are appended to a ring buffer that powers `simlock events --follow`
  and serves as the audit trail.

# Events

Catalog of business events carried on the daemon's event bus. Naming and
authoring rules live in [agent-rules/events.md](agent-rules/events.md) —
in short: `subject.past-tense-fact`, emitted post-commit, facts not commands.

> Status: **planned catalog** — update the Status column as events are
> implemented, and add new events here in the same change that introduces them.

## Lease lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `lease.requested` | request spec, requester, wait policy | a lease request is accepted by the daemon | LeaseAcquisitionCoordinator | implemented |
| `lease.queued` | request id, queue position | no capacity; request entered the wait queue | LeaseAcquisitionCoordinator | implemented |
| `lease.granted` | lease id, device id, requester, mode (held/detached) | a device was assigned and handed out | LeaseLifecycle | implemented |
| `lease.renewed` | lease id, new deadline | an explicit `pitlane lease renew` succeeded (either mode), **or** a held-mode connection that declared the `heartbeat` capability answered a `lease.heartbeat` push (fires once per lease per `lease.heartbeatIntervalMs` while the holder stays alive) | LeaseLifecycle | implemented |
| `lease.released` | lease id, device id, reason (closed/explicit/killed/orphaned/device-lost) | holder connection closed, explicit release, (orphaned) a `held` lease found still persisted at daemon startup, which cannot have a live holder across a restart, or (device-lost) a leased device could not be recovered after it stopped running outside pitlane | LeaseLifecycle | implemented |
| `lease.expired` | lease id, device id | TTL backstop fired without a heartbeat sliding it first — for a capability-declaring holder this means it stopped ponging (crashed, hung, or lost its socket); for one that never declared the capability it means the grant-time TTL (or the last explicit `pitlane lease renew`) simply ran out, exactly as before this change | LeaseLifecycle | implemented |
| `lease.rejected` | request spec, reason (timeout/no-wait/unresolvable-spec/already-leased/boot-timeout/killed) | a request ended without a grant | LeaseAcquisitionCoordinator / WaitQueue | implemented |

## Device lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `device.provisioned` | device id, spec, driver, duration | driver `provision` committed to registry | Registry | implemented |
| `device.ready` | device id, boot duration | readiness probe passed | Registry | implemented |
| `device.reclaimed` | device id, strategy (erase/snapshot/wipe), duration | fresh-state reclaim finished | Registry | implemented |
| `device.purge-failed` | device id, lease id, attempted strategy, duration, stable error summary | release-time purge failed; the device enters `quarantined` (see below) rather than rejoining the pool | WarmPoolCoordinator | implemented |
| `device.quarantined` | device id, max retries, next retry deadline | a device committed to `quarantined` — present in the registry, still counted as running, not eligible for a grant; fires immediately after `device.purge-failed` | QuarantineCoordinator | implemented |
| `device.quarantine-recovered` | device id, attempts, reclaim strategy | a quarantined device's retried purge succeeded; it returned to `ready`/`shutdown` and rejoined the warm pool | QuarantineCoordinator | implemented |
| `device.quarantine-abandoned` | device id, attempts | a quarantined device exhausted its configured retry budget (`warmPool.quarantine.maxRetries`) and was destroyed | QuarantineCoordinator | implemented |
| `device.quarantine-stranded` | device id, attempts, stable error summary | a quarantined device exhausted its retry budget and the destroy that should have retired it also failed; it stays `quarantined` with no further retry until an operator intervenes | QuarantineCoordinator | implemented |
| `device.shutdown` | device id, initiator (rule/command) | device stopped, still on disk | Registry; WarmPoolCoordinator for interrupted reclaim recovery | implemented |
| `device.deleted` | device id, initiator | device removed from disk and registry | Registry | implemented |
| `device.foreign-state-detected` | device id, platform, expected (running/stopped), observed (running/stopped) | doctor reconcile found a managed device's observed boot state disagreeing with the committed registry state | Doctor | implemented |
| `device.foreign-provenance-detected` | device id, platform, detail (erased/mark-mismatch/durable-mark-missing) | doctor reconcile found a managed device's provenance marks no longer proving Pitlane owns it | Doctor | implemented |
| `device.crash-detected` | device id, lease id, platform, observed | a leased device was observed `stopped` for `health.stableObservations` consecutive ticks | LeaseHealthMonitor | implemented |
| `device.recovered` | device id, lease id, attempts, duration | a crashed leased device was rebooted under its existing lease and passed readiness | LeaseHealthMonitor | implemented |
| `device.recovery-failed` | device id, lease id, attempts, reason, error | recovery could not restore a leased device (absent from driver reality, provenance drift, or attempts exhausted) and its lease was released | LeaseHealthMonitor | implemented |

## System

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `daemon.started` | version, config snapshot | daemon finished startup + reconcile | DaemonServer | implemented |
| `daemon.stopping` | reason | graceful shutdown began | DaemonServer | implemented |
| `disk.pressure-detected` | free bytes, threshold | free disk crossed under the configured threshold (edge-triggered: once per crossing, not once per tick while it persists) | CleanupReaper | implemented |
| `cleanup.executed` | rule name, action, target, reason | cleanup executor committed a proposed action | CleanupExecutor | implemented |
| `doctor.reconciled` | drift findings | daemon reconciliation completed | Doctor | implemented |

## Conventions recap

- Every event carries: `timestamp`, `event`, `payload`, emitting module.
- Events are appended to a ring buffer that powers `pitlane events --follow`
  and serves as the audit trail.

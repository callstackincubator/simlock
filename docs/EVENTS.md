# Events

Catalog of business events carried on the daemon's event bus. Naming and
authoring rules live in [agent-rules/events.md](agent-rules/events.md) —
in short: `subject.past-tense-fact`, emitted post-commit, facts not commands.

> Status: **planned catalog** — update the Status column as events are
> implemented, and add new events here in the same change that introduces them.

## Lease lifecycle

| Event | Payload (key fields) | Emitted when | Status |
|---|---|---|---|
| `lease.requested` | request spec, requester, wait policy | a lease request is accepted by the daemon | implemented |
| `lease.queued` | request id, queue position | no capacity; request entered the wait queue | implemented |
| `lease.granted` | lease id, device id, requester, mode (held/detached) | a device was assigned and handed out | implemented |
| `lease.renewed` | lease id, new deadline | detached-mode renew succeeded | implemented |
| `lease.released` | lease id, device id, reason (closed/explicit/killed) | holder connection closed or explicit release | implemented |
| `lease.expired` | lease id, device id | TTL backstop fired | implemented |
| `lease.rejected` | request spec, reason (timeout/no-wait/unresolvable-spec/already-leased/boot-timeout) | a request ended without a grant | implemented |

## Device lifecycle

| Event | Payload (key fields) | Emitted when | Status |
|---|---|---|---|
| `device.provisioned` | device id, spec, driver, duration | driver `provision` committed to registry | implemented |
| `device.ready` | device id, boot duration | readiness probe passed | implemented |
| `device.reclaimed` | device id, strategy (erase/snapshot/wipe), duration | fresh-state reclaim finished | implemented |
| `device.purge-failed` | device id, lease id, attempted strategy, duration, stable error summary | release-time purge failed after the resulting state committed; the first version may still reuse a readiness-checked device | implemented |
| `device.shutdown` | device id, initiator (rule/command) | device stopped, still on disk | implemented |
| `device.deleted` | device id, initiator | device removed from disk and registry | implemented |
| `runtime.deleted` | runtime id, initiator | runtime / system image GC'd | planned |

## System

| Event | Payload (key fields) | Emitted when | Status |
|---|---|---|---|
| `daemon.started` | version, config snapshot | daemon finished startup + reconcile | implemented |
| `daemon.stopping` | reason | graceful shutdown began | implemented |
| `disk.pressure-detected` | free bytes, threshold | free disk crossed configured threshold | planned |
| `cleanup.executed` | rule name, action, target, reason | reaper executed a proposed action | implemented |
| `doctor.reconciled` | drift findings | state DB reconciled against simctl/adb reality | implemented |

## Conventions recap

- Every event carries: `timestamp`, `event`, `payload`, emitting module.
- Events are appended to a ring buffer that powers `pitlane events --follow`
  and serves as the audit trail.

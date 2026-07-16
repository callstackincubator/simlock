# Events

Catalog of business events carried on the daemon's event bus. Naming and
authoring rules live in [agent-rules/events.md](agent-rules/events.md) —
in short: `subject.past-tense-fact`, emitted post-commit, facts not commands.

> Status: **planned catalog** — update the Status column as events are
> implemented, and add new events here in the same change that introduces them.

## Lease lifecycle

| Event | Payload (key fields) | Emitted when | Status |
|---|---|---|---|
| `lease.requested` | request spec, requester, wait policy | a lease request is accepted by the daemon | planned |
| `lease.queued` | request id, queue position | no capacity; request entered the wait queue | planned |
| `lease.granted` | lease id, device id, requester, mode (held/detached) | a device was assigned and handed out | planned |
| `lease.renewed` | lease id, new deadline | detached-mode renew succeeded | planned |
| `lease.released` | lease id, device id, reason (closed/explicit/killed) | holder connection closed or explicit release | planned |
| `lease.expired` | lease id, device id | TTL backstop fired | planned |
| `lease.rejected` | request spec, reason (timeout/no-wait/unresolvable-spec) | a request ended without a grant | planned |

## Device lifecycle

| Event | Payload (key fields) | Emitted when | Status |
|---|---|---|---|
| `device.provisioned` | device id, spec, driver, duration | driver `provision` committed to registry | planned |
| `device.ready` | device id, boot duration | readiness probe passed | planned |
| `device.reclaimed` | device id, strategy (erase/snapshot/wipe), duration | fresh-state reclaim finished | planned |
| `device.shutdown` | device id, initiator (rule/command) | device stopped, still on disk | planned |
| `device.deleted` | device id, initiator | device removed from disk and registry | planned |
| `runtime.deleted` | runtime id, initiator | runtime / system image GC'd | planned |

## System

| Event | Payload (key fields) | Emitted when | Status |
|---|---|---|---|
| `daemon.started` | version, config snapshot | daemon finished startup + reconcile | planned |
| `daemon.stopping` | reason | graceful shutdown began | planned |
| `disk.pressure-detected` | free bytes, threshold | free disk crossed configured threshold | planned |
| `cleanup.executed` | rule name, action, target, reason | reaper executed a proposed action | planned |
| `doctor.reconciled` | drift findings | state DB reconciled against simctl/adb reality | planned |

## Conventions recap

- Every event carries: `timestamp`, `event`, `payload`, emitting module.
- Events are appended to a ring buffer that powers `pitlane events --follow`
  and serves as the audit trail.

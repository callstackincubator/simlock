# 0009. Gateway routing is a list of stages, and a request that cannot be served fails at once

- **Status:** Accepted — not yet implemented
- **Date:** 2026-10-01
- **Issue:** [#173](https://github.com/callstackincubator/simlock/issues/173)
- **Supersedes:** nothing. Narrows [ADR
  0005](0005-gateway-and-worker-modes.md): requirement 7 (the download
  policy on a view is no longer a routing input), requirement 10 (a request
  that cannot be served is rejected before it enters the queue), requirement
  11 (a request no worker can serve is rejected, not passed over; an
  immediate `NO_CAPACITY` is remembered; a "cannot serve" refusal is retried
  elsewhere), requirement 13 (the policy, and downloads through a gateway),
  and Decision 6 (the gateway no longer forwards `allowDownload`). Narrows [ADR
  0007](0007-a-lease-request-chooses-the-device-mode.md): its consequence
  that a gateway does not look at the mode, and §9, since status now carries
  one boolean derived from the spec's mode (§6). Narrows [ADR
  0008](0008-the-catalog-pairs-models-with-runtimes-and-status-carries-host-facts.md)
  §1: routing now reads the catalog's new fields, and the clean-up of
  `models` it left to #173 is not done (§3).
- **Depends on:** ADR 0007 (#172) and ADR 0008 (#171).

## Context

The gateway picks a worker with one function: filter by platform, model, and
runtime, prefer a warm device, otherwise take the worker with the most free
slots. Five faults follow from it.

- A request no worker can serve waits in the queue, forever when it has no
  timeout, and blocks its requester from asking again.
- The gateway matches model names exactly. Workers match any letter case and
  the Android AVD id.
- The gateway checks the model and the runtime separately. A worker that has
  both and cannot pair them gets the request, refuses it, and that refusal is
  final.
- The mode is ignored. A slim warm device is a hit for a `full` request.
- A worker that answers `NO_CAPACITY` is asked again at once, in a loop,
  because every view refresh re-runs dispatch and picks it again.

Each fix would be another special case in that one function.

## Decision

### 1. Routing is an ordered list of stages

A stage is a pure function over worker views, of one of two kinds. A
**filter** drops workers. A **rank** scores them. A rank whose best score is
zero or less abstains and changes nothing. Otherwise it decides: the best
scorers stay, which may be all of them. A rank may be marked as settling:
when it decides, the walk ends there.

The pick is the first remaining worker, in ascending worker id, provided at
least one rank decided. With none, there is no pick. The deciding stage is
the last rank that removed a worker, or, when none removed any, the last rank
that decided.

A name in `gateway.routing` maps to a list of stages in code. No config key
lists or orders stages. Adding or removing a stage touches that stage and the
list, and no other stage.

Today's policy is first re-expressed as three stages (`eligible`,
`warm-hit`, `free-capacity`) that produce the same pick and the same reason
for every input. New stages replace or join them afterwards, one task at a
time.

### 2. The final list

| # | Stage | Kind | Rule |
| --- | --- | --- | --- |
| 1 | `takes-requests` | filter | connected, not drained, catalog read in this session |
| 2 | `can-serve` | filter | the catalog pairs the model with the runtime (§3) |
| 3 | `healthy` | filter | health is `running` |
| 4 | `idle-queue` | filter | the worker's own queue is empty |
| 5 | `warm-hit` | rank, settles | a `ready` device fits the request (§6) |
| 6 | `free-slot` | filter | a free running slot, platform and global; a running device that is not leased counts as free |
| 7 | `ram-budget` | rank | not at its RAM budget |
| 8 | `free-capacity` | rank | most free running capacity |

A worker dropped by stages 3 to 8 is busy, not unable. Its requests wait.
Only stages 1 and 2 decide whether a request can be served at all (§4).

`free-slot` counts a running device that is not leased as free, on the platform
and globally: the planner evicts such a device when a running limit blocks a
request no warm device fits, so the worker serves it at once. A slot held by a
lease or a reservation is taken. `free-capacity` still ranks by
`maxRunning - running - reserved`, so among kept workers one with idle devices
ranks below an empty one.

`idle-queue` is a filter because a worker with a local waiter refuses every
`noWait` request, warm device or not.

### 3. One function decides whether a worker can serve a request

It reads the worker's catalog from #171. The model matches the first entry of
`models` whose name or alias equals the requested name, ignoring case. A
named runtime must be in that model's `modelRuntimes`; an unnamed one needs a
non-empty list. Only installed runtimes count.

The gateway forwards the worker's own name for the model, so the worker
resolves exactly what the gateway matched.

The gateway sends `allowDownload: false` to every worker. The field stays
accepted from clients and has no effect through a gateway. The worker's
download policy stays on the view for display; routing does not read it.

An Android `devices.xml` profile whose name an earlier profile already
answers to stays in `models`. First match wins on the gateway as on the
worker, so routing does not need it removed. ADR 0008 left that clean-up to
#173; it is not done.

### 4. A request that cannot be served fails at once

Two terms. A worker **takes requests** when it passes stage 1. The gateway
**knows** a worker when it holds a catalog read from it and the worker is not
`incompatible`. The view keeps the last catalog across a lost uplink, so a
disconnected worker is known until retention removes it, and a reconnecting
one stays known while its new catalog is on the way.

| Order | Situation | Result |
| --- | --- | --- |
| 1 | No worker takes requests | `NO_CAPACITY` |
| 2 | No known worker has the platform | `NO_DRIVER` |
| 3 | No known worker lists the model | `UNKNOWN_MODEL` |
| 4 | No known worker has the runtime, or pairs it with the model | `RUNTIME_MISSING`, `downloadable: false` |
| 5 | A known worker can serve it, but none that takes requests can | `NO_CAPACITY` |
| 6 | Otherwise | route, or wait in the queue |

The table is evaluated in the dispatch walk, before the stages, for every
request in it. The walk covers the queued requests and, last, a request that
has just arrived and is not queued yet. That one place therefore serves both:
an arriving request on rows 1 to 5 is rejected without ever entering the
queue, and when a drain or a lost uplink changes the views, the walk runs
again and a waiting request that has moved to rows 1 to 5 is rejected.

A worker connecting for the first time, whose catalog has not arrived yet,
neither takes requests nor is known. Alone, it gives row 1, never a false
`UNKNOWN_MODEL`. The view records when the catalog was read in the current
session, so "not read yet" and "read and empty" can be told apart.

### 5. Refusals

A worker's immediate `NO_CAPACITY` is remembered per request, against a key
built from that worker's view (capacity, queue depth, health, devices,
leases; not timestamps). The worker is not picked again for that request
while its key is unchanged. The registry keeps notifying on every refresh.

A `noWait` request that was refused this way gets one more walk. If no other
worker is picked in it, the request is rejected with `NO_CAPACITY`. Today it
stays queued, which `noWait` never asked for.

A worker's `UNKNOWN_MODEL`, `RUNTIME_MISSING`, or `NO_DRIVER` before any
progress push excludes that worker for that request, refreshes its catalog,
and returns the request to the walk. After a progress push a failure is
final, as today.

Both kinds of exclusion belong to one request, so they are not stages. The
coordinator takes the excluded workers out of the views it hands to the table
and to the stages, which stay pure functions of what they are given. When the
table, over those reduced views, no longer says route or wait, a request that
holds a "cannot serve" refusal is rejected with the last such refusal instead
of the table's own code.

### 6. Warm hits follow the mode

Status reports, for each device, `servesDefaultMode`: whether the device's
pool mode is the worker's default mode for its platform. The worker computes
it where it resolves the default (ADR 0007 §2).

A `ready` device is a warm hit when the platform, the worker's name for the
model, and the runtime fit, and:

- the request says `full` and the device reports `mode: "full"`;
- the request says `slim` and the device reports `mode: "slim"`;
- the request names no mode and the device reports `servesDefaultMode`.

The runtime fits when it is the one requested. With none requested it must be
the catalog's `defaultRuntime` if the model pairs with it, or else the
model's only paired runtime. The gateway compares no versions.

A miss costs a cold boot on the worker, never a wrong device: the worker
still applies its own rules.

`warm-hit` settles before the RAM budget is looked at. Reusing a warm device
creates nothing, so a worker at its budget is still the right pick for it.

### 7. The RAM budget is one boolean per platform

Status capacity gains `atRamBudget` for each platform: whether creating one
more full device of that platform would be refused for RAM. It comes from the
same function the worker's planner calls. It is a rank, so a worker at its
budget is still asked when it is the only one. A gateway's own status reports
it for a platform when every connected worker does.

### 8. Events and the wire

`request.dispatched` gains `stage`, the deciding stage's name, and `mode`
when the request named one. `reason` keeps its two values: `warm-hit` when
the deciding stage is `warm-hit`, `free-capacity` otherwise. `lease.rejected`
on a gateway gains the reason `no-worker` for rows 1 and 5; rows 2 to 4 use
`unresolvable-spec`. All additive.

`servesDefaultMode` and `atRamBudget` are required in status, so the task
that adds each raises the protocol version by one.

## Consequences

- A request for something the fleet does not have fails in one round trip,
  with the code a single worker gives.
- A request fails with `NO_CAPACITY` when its only capable worker is drained
  or loses its uplink, even while waiting. A short drop fails waiting
  requests; they are retried by the caller.
- Views are not persisted. After a gateway restart, a request for a model
  only a not-yet-reconnected worker has gets `UNKNOWN_MODEL` until that
  worker is back.
- `--allow-download` does nothing through a gateway until the downloads
  feature is specified.
- A foreign-ABI Android image still makes a worker able to serve. Routing
  does not read the ABI.
- Two accepted gaps in warm hits: a slim-pool device whose slim pass failed
  reports `full` and can be a false hit for a `full` request; on a
  default-slim worker, a full device on a runtime that cannot be slimmed is
  not counted as a hit for a request with no mode.
- The download policy on the view becomes display-only.
- The docs change with the implementation. Each task updates the docs it
  makes true.

## Alternatives considered

- **Sort all workers by a tuple of keys, with no settling stage.** Simpler to
  describe. Rejected: the pick among several warm workers would change, and
  today's policy could not be reproduced exactly as the first step.
- **Stages chosen in config.** Rejected: every combination would be supported
  behaviour to document and test.
- **Count only connected workers as known.** Rejected by the maintainer's
  table: a request whose capable worker is merely away is the fleet's
  problem (`NO_CAPACITY`), not the request's (`UNKNOWN_MODEL`).
- **Wait for a worker that is away instead of failing.** Rejected: that is
  the wait-forever fault this record removes.
- **Make the registry notify only on real change.** It would end the
  `NO_CAPACITY` loop too. Rejected: lease reconciliation relies on a
  notification per refresh.
- **Forward the name as the client typed it.** Rejected: the gateway and the
  worker would each match it, and could disagree.
- **Track, per device, the mode of the request that created it.** It closes
  one warm-hit gap. Rejected: it needs a new stored field for a case that
  costs only a cold boot.
- **Report RAM use in bytes for routing.** Rejected here: the gateway would
  need each worker's per-device sizes. #174 reports bytes for people.

# 0015. A device transition is an event, and the record says when it entered its state

- **Status:** Accepted — not yet implemented
- **Date:** 2026-10-04
- **Issue:** [#314](https://github.com/callstackincubator/simlock/issues/314)
- **Supersedes:** nothing.
- **Depends on:** [ADR 0006](0006-events-and-log-are-two-records.md) for the
  event file, [ADR
  0013](0013-the-console-reads-routes-and-follows-the-event-stream.md) §4
  for times counted in the browser, and [ADR
  0014](0014-an-event-has-one-id-minted-where-the-fact-happened.md) §2 for a
  relayed event keeping the worker's `timestamp`, which §7 rests on.

## Context

A device is in one of seven states: `provisioning`, `ready`, `leased`,
`reclaiming`, `quarantined`, `shutdown`, `deleted`. The legal moves between
them are fifteen edges plus registration. Every move but one goes through
one pure function, `transition`, which refuses an edge the table does not
list. The one exception is the doctor marking a device missing: the registry
writes `deleted` directly, from `ready`, `reclaiming` or `quarantined`,
along edges the table does not have. Every write is committed by the
registry. There is no second writer of device state.

The events say less than that. Four modules emit nine names for these
moves. The registry emits `device.ready`, `device.shutdown`,
`device.deleted` and `device.reclaimed`, keyed on the destination or on
leaving `reclaiming`. Entering `leased` and `reclaiming` has no device
event; the lease lifecycle emits `lease.granted`, `lease.released` and
`lease.expired`. Entering and leaving `quarantined` is emitted by the
quarantine coordinator, and a reclaim finished without a purge by the warm
pool coordinator. A consumer that wants "this device's state changed"
subscribes to all of them, and still cannot tell which state a device came
from: `device.ready` does not say whether it was `provisioning` or
`shutdown`.

A device record has `createdAt`, `quarantinedAt` and `lastLeaseEndedAt`.
Each doubles as the entry time of one state, and `transitionEnteredAt`
reads them for the stall check and for `transitionAgeMs`. `ready`, `leased`
and `shutdown` have none, so the console shows a dash for how long such a
device has been where it is (#88). The event file cannot rebuild the time
either: two states have no device event, and no event says `from`.

## Decision

### 1. `device.state-changed`

One event, `device.state-changed`, with the payload `deviceId`, `from` and
`to`. `from` is absent when the record was registered, since it came from
nothing. The time is the envelope's `timestamp`.

Nothing else is in the payload. Events rule 6 asks for what a consumer
needs so it does not have to query state that moved on; here the fields a
consumer would want next are the reason, which the specific event beside it
carries, and the spec, which does not change with the state. This is a thin
payload by choice, and it can grow additively if a consumer shows a need.

### 2. The registry is its only emitter, from its one commit path

Every write of device state ends in the registry's one commit. After that
commit, the registry compares each committed record with the one it
replaced and emits `device.state-changed` for each whose state differs. One
place, so "every transition" is true by construction: the generic
transition, registration, grant, release, quarantine entry and exit, the
reclaim completed without a purge, the quarantined delete and the doctor's
missing-device delete all pass through it. No module outside the registry
emits it.

No order is promised between `device.state-changed` and the specific event
of the same move. Five of those are emitted by another module after the
registry returns, and events rule 5 already forbids a handler from depending
on order.

### 3. The specific events stay

`device.provisioned`, `device.ready`, `device.reclaimed`, `device.shutdown`,
`device.deleted`, `device.quarantined`, `device.quarantine-recovered` and
the rest keep their names, payloads and emitters. They carry the why:
strategy, duration, initiator, attempts. `device.state-changed` carries the
what.

### 4. A new state widens the vocabulary, not the catalog

A state added later appears as a new value of `from` and `to`. A consumer
must tolerate a value it does not know, the way it tolerates a new
`lease.rejected` reason. No new event name is needed for a new transition.

### 5. The record says when it entered its state

A device record gains `stateEnteredAt`, the wall-clock moment it entered
its current state. `transition` takes the time as an argument and stamps it;
registration stamps it. The doctor's missing-device delete goes through
`transition` too, and the legal table gains the `deleted` edges that path
already takes, so the table stops lying and the one function stamps every
move.

`transitionEnteredAt` goes away. The stall check and `transitionAgeMs` read
`stateEnteredAt`. The three existing timestamps stay for what each means on
its own: when the device was created, when its purge first failed, when its
last lease ended. None of them is an entry time any more.

A record written before this field is loaded with `stateEnteredAt` taken
from the one existing timestamp that is exactly its entry time:
`createdAt` for `provisioning`, `lastLeaseEndedAt` for `reclaiming`,
`quarantinedAt` for `quarantined`. For every other state it loads absent.
Absent means unknown; nothing guesses, and the next transition sets it.

### 6. The time is returned as a time, on every device shape

`status.get`, `list.get` for devices, the worker view's devices and the
trimmed devices a gateway returns all carry `stateEnteredAt` as an absolute
time under that name, when the record has one. It is on the agent-visible
status shape too: when a device entered its state is not bookkeeping, it is
what an agent waiting for one wants to know. They do not return an age: the
browser computes durations from timestamps and ticks them itself (ADR 0013
§4), and so can any other client. `transitionAgeMs` on a mid-transition
device stays, now read from the same field.

### 7. The event does not carry the time

`stateEnteredAt` is the exact instant; the envelope's `timestamp` is the
moment the commit was published, a disk write later. A consumer replaying
the event file rebuilds entry times from the events to that precision; a
consumer reading a snapshot gets the field. Two readers, one truth each.

### 8. On a gateway

`device.state-changed` is relayed like every `device.*` event, gains
`payload.workerId`, and triggers the worker refresh those events already
trigger. The worker view's devices carry `stateEnteredAt` the way they carry
every other device field.

## Consequences

- One more event per device transition, on every bus and in every event
  file. On a busy gateway the ring turns over faster by that much.
- The console shows time in state for every device, from one field, and
  keeps the dash only for a record that has none.
- A consumer that wants a device's timeline subscribes to one name.
- The lease events stay the way to learn who holds a device. This decision
  adds a second, uniform way to learn that its state moved.
- `transition` is no longer callable without a time, and the missing-device
  delete is no longer a bypass. The legal table grows by three `deleted`
  edges it already took in practice.
- Both `EVENTS.md` files gain the event. `HTTP-API.md`, `CLIENT.md` and
  `CLI.md` gain `stateEnteredAt` where they list device fields.
  `CONSOLE.md` drops the dash for `ready`, `quarantined` and `shutdown`.
- A registry test proves that every state-writing path emits the event once
  with the right `from` and `to`, and that a commit which leaves a device's
  state alone emits nothing for it. A second test proves the loader fills
  `stateEnteredAt` for the three states it can and leaves it absent for the
  rest.

## Alternatives considered

- **One event per edge.** Sixteen names, most duplicating `device.ready`
  and its siblings, and two new names for every state added later.
  Rejected.
- **Fill the two gaps with `device.leased` and `device.reclaim-started`.**
  Then every state has an "entered" event. Rejected: a consumer still
  subscribes to eight names and keeps a table from name to state, and none
  of them says `from`. Either can still be added later for a consumer that
  needs a lease fact keyed by device.
- **Add `from` to every specific payload.** Additive, but the same field in
  seven payloads with the rule in seven places. Rejected.
- **Emit from each registry method instead of the commit path.** Nine emit
  lines, and the next method forgets one. Rejected.
- **Carry `stateEnteredAt` on the event.** Rejected: the envelope's
  `timestamp` is that instant to within a commit.
- **Return an age instead of a time.** Rejected: ADR 0013 §4 counts in the
  browser, and an age is stale the moment it is sent.
- **Keep `transitionEnteredAt` beside `stateEnteredAt`.** Rejected: two
  answers to one question, which architecture rule 12 says will disagree.
- **Rebuild entry times from the event file.** Rejected: two states have no
  device event today, and no event says `from`. After this decision it is
  possible, and §7 says so, but a snapshot reader should not have to.

# 0016. Usage figures are derived on read from the event history

- **Status:** Proposed
- **Date:** 2026-10-05
- **Issue:** [#329](https://github.com/callstackincubator/simlock/issues/329)
- **Supersedes:** nothing. Extends [ADR
  0006](0006-events-and-log-are-two-records.md) §2 (how long the event file
  is kept) and applies [ADR
  0012](0012-a-worker-answers-the-fleet-operations-as-a-fleet-of-one.md) to
  one more operation.
- **Depends on:** [ADR 0006](0006-events-and-log-are-two-records.md) for the
  event file, [ADR
  0014](0014-an-event-has-one-id-minted-where-the-fact-happened.md) for ids,
  timestamps and `workerId` on a relayed event, [ADR
  0003](0003-one-typed-daemon-contract-behind-every-frontend.md) for the
  operation every surface calls.

## Context

An operator can see what a host or fleet is doing now and nothing about what
it did. The facts are in `events.jsonl`: every request, grant, release,
expiry, rejection, provision and boot is a line there, with an id that
survives restarts and relays. Nothing reads those lines back as numbers.

Three things stand between the file and the figures. A `lease.granted` does
not say which request it served or whether the device was warm, booted from
shutdown or created for it; a `lease.rejected` names neither its request nor
its requester. Capacity and queue depth are never recorded, only shown by
`status.get` as a snapshot. And the file is kept by size alone, five
mebibytes and one rotated generation, so a week of history on a busy host is
gone before anyone asks for it.

On a gateway the same request appears twice in the merged history: the
gateway's own fleet-queue events and the worker's relayed copies, with
`workerId` and a requester prefixed `gw:<gateway>:`.

## Decision

### 1. The event history is the only source, and figures are computed when asked

There is no metrics store and no counter in the lease path. One read
operation, `usage.get`, takes a window, reads the events the history holds
for it, and hands them to a pure function that returns the figures. The CLI,
the HTTP API and the console all call that operation; none of them computes
a figure of its own. The function is platform-agnostic and takes an array of
envelopes, so a test feeds it events and reads numbers.

Because every surface reads the same history through the same function, the
figures agree with `simlock events` for the same window, and they survive a
restart because the file does.

### 2. The events carry the facts the figures need

`lease.granted` gains `requestId`, the id of the request it served, and
`source`: `warm` for a device that was ready, `booted` for one booted from
shutdown, `provisioned` for one created for this request, including the
cases where an idle device was evicted to make room. `lease.rejected` gains
`requestId` and `requester`. Both changes are additive (events rule 6).

From these, one request's life is four timestamps joined by ids: waited is
`lease.requested` to `lease.granted` or `lease.rejected` by `requestId`;
held is `lease.granted` to `lease.released` or `lease.expired` by `leaseId`;
turnaround is `lease.requested` to that end. Provisioning time is
`device.provisioned.duration`; boot time is `device.ready.bootDuration`.
Nothing is inferred from timing alone.

### 3. Capacity and queue depth are events

A worker emits `capacity.changed` after any committed change to the figures
`status.get` reports under `capacity`: per platform running, maximum,
reserved and warm, and the RAM budget's used and limit bytes when the
strategy keeps one. A worker emits `queue.changed { depth }` when its wait
queue's depth changes, and a gateway emits the same for its fleet queue.
Each is one event per committed change, emitted post-commit (events rule 3),
never on a timer.

Utilisation over time is the step function these events draw. Peak and
time-weighted mean over a window come from the steps, and the step in force
at the window's start comes from the last event before it.

### 4. The event log keeps a window of time, bounded by size

Two keys join `eventLog.rotateBytes`. `eventLog.retention`, a duration, says
how long an event is kept: seven days by default. `eventLog.maxBytes` caps
the total the history may take on disk: 256 MiB by default. `rotateBytes`
stays the size of one generation.

When the current file passes `rotateBytes` it rotates, and the rotated
generations are numbered from `.1`, the newest, upward. After a rotation,
every generation whose newest line is older than `retention` is deleted,
then the oldest generations are deleted until the total fits `maxBytes`.
The current file is never deleted. The reader merges every generation and
the current file, oldest first, deduplicating by id as it already does.

Retention bounds every reader of the file: `simlock events --since`,
`events.replay`, and `usage.get`.

### 5. Figures say how far back they reach

Every answer from `usage.get` carries the window it was asked for and
`coversFrom`: the later of the window's start and the oldest timestamp the
history holds. When `coversFrom` is later than the window's start the answer
is marked `partial`, and every surface shows that beside the figures. A
window that ends before the oldest held event is refused with
`HISTORY_NOT_KEPT`, naming the oldest time the history reaches. An empty
history covers any window: nothing happened that was not recorded.

### 6. On a gateway, the figures are the fleet's, from the gateway's own history

A gateway answers `usage.get` from its merged history and nothing else: no
fan-out, no new protocol. One rule tells the two copies of a fleet request
apart. Request facts come from the gateway's own events, those without
`workerId`: requests, queueing, waits, rejections and the fleet queue's
depth. Device facts come from relayed events, those with `workerId`:
grants, held time, provisioning, boots, capacity and device incidents, each
attributed to its worker. A relayed `lease.requested`, `lease.queued`,
`lease.rejected` or `queue.changed` is not counted; the gateway forwards
every request as `noWait`, so a worker's queue never holds a fleet request.

A fleet request is joined to its grant through `request.dispatched`: the
gateway's request id names the worker and the requester, and the first
relayed `lease.granted` from that worker for the namespaced requester at or
after the dispatch is the grant. The core allows one open request per
requester, so that match is unique.

The answer has fleet totals and one entry per worker. A worker answers the
same shape as a fleet of one (ADR 0012): totals, and one entry for itself.
A worker's events from before its uplink joined are absent on the gateway,
as they are from `simlock events` there.

### 7. The daemon joins token labels

A requester over HTTP is a token id. The per-requester figures carry `label`
when the requester is a token the answering daemon's store knows. A gateway
strips its own `gw:<instance>:` prefix from a relayed requester before the
lookup; a prefix it does not recognise stays as it is. No surface looks a
label up for itself.

### 8. The daemon buckets the series

Series over time (utilisation in slots and RAM, queue depth, waiting) come
bucketed from `usage.get`, with the bucket width in the answer. The daemon
picks the width from the window's length so a chart has a bounded number of
points; a client never re-buckets.

## Consequences

- `lease.granted` and `lease.rejected` grow by two fields each; the file
  grows by one `capacity.changed` per device transition and one
  `queue.changed` per queue change. On a host at capacity that is roughly
  twice today's line count.
- The history on disk can reach 256 MiB by default, against about 10 MiB
  today. A host that wants less sets `eventLog.maxBytes` or
  `eventLog.retention`.
- A config that sets `eventLog.rotateBytes` keeps working: it still sizes
  one generation.
- ADR 0006's consequence "kept by size, not by age, with one rotated
  generation" is narrowed to §4 above.
- `usage.get` reads the whole retained history for a wide window; at the
  default cap that is a few hundred thousand lines, read once per call. The
  console refetches on events, so the daemon may compute often. If that
  proves costly the fix is a cache keyed on the newest event id, inside the
  daemon, not a store.
- A worker's own `usage.get` after it joined a fleet shows requests with the
  `gw:` prefix and `noWait`, with zero wait, since the gateway queued them.
  The fleet view on the gateway is where their wait shows.
- Both `EVENTS.md` files gain two events and two changed payloads;
  `CONFIGURATION.md` gains two keys; `CLI.md`, `HTTP-API.md` and
  `CONSOLE.md` gain the command, the route and the view.

## Alternatives considered

- **A metrics store, or counters kept by the lease path.** Rejected: a
  second record that can disagree with the first, and the lease path pays
  for something an agent never needs.
- **Infer the grant source from `device.provisioned` and `device.ready`
  timing.** Rejected: wrong under concurrent requests and warm-pool boots,
  and a figure that is sometimes wrong is worse than one that is absent.
- **Reconstruct capacity over time from device and lease events.**
  Rejected: RAM per device is in no event, and the rebuild would copy the
  capacity module's accounting in a second place.
- **Sample capacity once a minute.** Rejected: a spike between samples is
  invisible, and an idle host writes a line a minute for nothing.
- **Replace `eventLog.rotateBytes` with the new keys.** Rejected: a config
  that sets it breaks on upgrade, for no gain.
- **Fan `usage.get` out to workers from the gateway.** Rejected: a protocol
  bump, a second compute surface, and the fleet queue's waits live only on
  the gateway anyway.
- **Each surface joins token labels.** Rejected: three copies of one rule.
- **A Prometheus endpoint in the same change.** Deferred: the figures come
  first; a scrape endpoint reads them later.

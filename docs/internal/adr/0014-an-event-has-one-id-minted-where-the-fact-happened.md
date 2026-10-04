# 0014. An event has one id, minted where the fact happened

- **Status:** Accepted
- **Date:** 2026-10-04
- **Issue:** [#314](https://github.com/callstackincubator/simlock/issues/314)
- **Supersedes:** nothing. Narrows [ADR
  0005](0005-gateway-and-worker-modes.md) requirement 22 (what a republished
  envelope keeps), [ADR 0006](0006-events-and-log-are-two-records.md) §5
  (one exception to additive-only, taken once, see §4) and [ADR
  0013](0013-the-console-reads-routes-and-follows-the-event-stream.md) §2
  (what makes two events the same).
- **Depends on:** [ADR 0006](0006-events-and-log-are-two-records.md) for the
  event file this id is for.

## Context

An event envelope carries `seq`, `timestamp`, `event`, `payload` and
`module`. `seq` is a counter that starts at 1 each time the daemon starts.
Nothing in the envelope lasts across a restart or is unique across a fleet.

Three readers need to tell events apart. The event file reader drops a line
it has already seen when the current file and its rotated generation
overlap. `simlock events --follow` drops a pushed event it already printed
from the replay. The console does the same for the stream and the replay.
All three use the pair `seq:timestamp` as the identity, because `seq` alone
starts again with every daemon (ADR 0013 §2).

A gateway republishes a worker's event (ADR 0005 requirement 22). It takes
the worker's `event`, `module` and `payload`, adds `workerId` to the payload,
and calls its own bus's `emit`. That mints a new `seq` from the gateway's
counter and a new `timestamp` from the gateway's clock. The same fact has one
identity in the worker's event file and a different one in the gateway's,
and the gateway's copy says when the gateway heard it, not when it happened.

ADR 0006 made `events.jsonl` the audit trail. An audit trail whose lines
cannot be named, and whose fleet copies cannot be joined to their source,
does half the job.

## Decision

### 1. Every envelope carries `id`

`id` is `evt_` followed by a value from the daemon's id generator, the way a
device is `dev_`, a lease `lse_`, a request `req_` and a token `tok_`. The
bus mints it when `emit` is called. Nothing in it is derived from the
instance id, the sequence or the clock, so it is unique across restarts and
across a fleet with no coordination. It is opaque: no reader parses it.

`id` is required: in the envelope type, in the `event` push a worker sends
its gateway, in `events.replay` and the event stream, and in every line of
`events.jsonl`. There is no envelope without one.

### 2. An id is minted once, where the fact happened

A gateway republishing a worker's event keeps the worker's `id` and the
worker's `timestamp`. The bus gets a second method for publishing an
envelope that already carries both; it mints only `seq`. `emit` keeps
minting all three. The relay is that method's only caller, and a test at
the module boundary keeps it so.

A worker's `id` and `timestamp` arrive over the wire, so they are claims
(safety rule 10). The push schema bounds both before the relay sees them:
`id` is a string of the shape in §1 and nothing longer, `timestamp` a finite
number. A push that fails is dropped and logged, as any malformed push is.
The bus does not check an incoming `id` against its ring; telling events
apart is the readers' job (§4).

### 3. `seq` is each bus's own counter

`seq` stays. It orders events within one run and within one millisecond on
the bus that holds them. On a gateway, a relayed event's `seq` is the
gateway's. `seq` is no longer part of an event's identity.

### 4. Identity is `id`

Two events are the same event when their `id` is the same. The event file
reader, `simlock events --follow` and the console dedupe by `id` and by
nothing else. `eventKey` returns the `id`.

A line in an event file with no `id` was written before this decision. The
reader skips it, the way it skips a line that is not JSON. This is one
exception to ADR 0006 §5's additive-only rule for the file, taken once and
recorded in `EVENTS.md` the way ADRs 0004 and 0007 recorded theirs.

### 5. A replay presents events in `timestamp` order, then `seq`

The console already does. `simlock events` and `events.replay` print the
file's order today, which on a gateway is arrival order. Once a relayed line
carries the worker's `timestamp`, arrival order and time order differ, and
two readers of the same data must not disagree. Time order wins for every
replay, from the ring or the file, with `seq` breaking ties within a
millisecond.

A live stream (`simlock events --follow`, `GET /v1/events/stream`) is
arrival order. A gateway would have to hold events back to sort a relayed
one among its own, and then the stream is not live. On a worker arrival
order is time order, since one process stamps and pushes every event.

### 6. The relay marks a worker's event in exactly one place

`payload.workerId`, added by the gateway as it republishes, is the only thing
that says an event was relayed and from where. Apart from that and `seq`
(§3), no field of the envelope changes on relay, and nothing is added to the
envelope itself. A worker's own events carry no marker: a worker does not
know it has a gateway above it, and its `simlock events` shows what it
always showed.

A fleet is one level deep: a gateway and its workers. A daemon runs in one
mode, and only the worker half opens an uplink. A fleet with a gateway behind
a gateway would need a route in the envelope, and that is the ADR that adds
one.

### 7. The protocol version moves

Requiring `id` on the wire is a breaking change, and the contract keeps no
shim behind one (ADR 0003 §6). The protocol range moves to the next version
with both ends equal, as every breaking change before it did. A worker and a
gateway on different sides of it do not overlap, and the worker is
`incompatible` in the gateway's registry rather than relayed half-right.

## Consequences

- One fact has one `id` in the worker's event file, the gateway's event
  file, both rings and both streams. The two files can be joined by it.
- The gateway's event file changes meaning in one place: a relayed line now
  carries when the fact happened, not when the gateway heard it. Across
  machines, `timestamp` order is clock order. A worker whose clock is behind
  the gateway's writes relayed lines that sort before the gateway's own of
  the same moment, and `simlock events --since` on the gateway filters by
  that timestamp. This is accepted: the alternative is a record that lies
  about when things happened. A worker whose clock is wrong is a worker to
  fix, not a case the gateway corrects for.
- ADR 0013 §4's clock correction uses the gateway's `Date` header. For a
  relayed event it corrects the browser against the gateway, not against the
  worker that stamped the event. The console's "how long ago" for a relayed
  event is off by the skew between the two machines, like §5's order.
- Event history from before the upgrade is not replayed. The lines stay in
  the file until rotation removes them, and nothing reads them.
- Each line of `events.jsonl` grows by one id.
- ADR 0006's consequence "`seq` restarts at 1 with every daemon ... `timestamp`
  orders them across runs" stays true. `id` is what names a line.
- ADR 0013 §2's rule "an event is the same event when its `seq` and
  `timestamp` both match" is narrowed to §4 above.
- Events rule 7 lists `id` with the fields every event carries. Both
  `EVENTS.md` files show it, with the exception in §4 recorded, and
  `HTTP-API.md` names it where it describes `GET /v1/events` and the stream.

## Alternatives considered

- **A time-sortable id (ULID).** The file could then be sorted by `id`
  alone. Rejected: `timestamp` and `seq` already give that order, and a ULID
  means a dependency or our own encoder.
- **`<instanceId>:<seq>`.** Rejected: `seq` restarts, so this is not unique
  across restarts.
- **`<instanceId>:<startedAt>:<seq>`.** Unique, and readable. Rejected: three
  parts to parse, and a consumer that reads structure out of an id will
  depend on it. An opaque id cannot be misread.
- **The gateway mints a new id on relay.** The smallest change. Rejected:
  one fact with two ids is the situation this decision exists to end.
- **A structured relay marker in the envelope (gateway id, worker id).**
  Rejected while the fleet is one level deep: the gateway's instance id is
  the same on every line of its own file, and `payload.workerId` already
  names the source.
- **Keep the gateway's `timestamp` on relay and add the worker's as a second
  field.** Rejected: two times on one fact, and every reader has to choose.
- **`id` optional on the wire, with `seq:timestamp` kept as a fallback.**
  Rejected: a second identity rule kept alive for a version nobody runs.
- **Readers keep file order on a gateway.** Rejected: the console sorts by
  time, so the CLI and the console would show the same fleet in two orders.
- **The gateway sorts its live stream too.** Rejected: it would have to hold
  every event back for some window to let relayed ones catch up, and a
  stream that is seconds late is not a live stream.

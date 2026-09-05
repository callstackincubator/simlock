# 0004. TTL-first leases on every transport

- **Status:** Accepted — not yet implemented
- **Date:** 2026-09-05
- **Issue:** [#114](https://github.com/callstackincubator/simlock/issues/114)
- **Supersedes:** nothing. Narrows [ADR
  0003](0003-one-typed-daemon-contract-behind-every-frontend.md): §3's
  `lease.heartbeat` operation row, §8's `lease.heartbeat` connection-scoped
  push and the held set kept for release-on-close, §9's rule that a `ttlMs`
  on a held `lease.request` is `BAD_REQUEST`, §10's `onLeaseLost` firing for
  each held lease when a connection dies, and §10/§11's lazy-only MCP
  reconnect. Also narrows the held/detached split in `docs/CLI.md`.

## Context

Simlock has two lease modes. A **held** lease lives as long as the daemon
connection that requested it: the daemon pushes `lease.heartbeat`, the
client pongs, the TTL slides, and closing the connection releases the lease.
A **detached** lease has a TTL the client must renew. HTTP offers only the
second, because "held lease = live connection" does not survive a real
network.

That split was fine while every holder sat on the same machine as the daemon.
It stops being fine the moment a lease has to pass through something that is
not the daemon — a gateway fronting several workers (ADR 0005). Held mode is
defined by a property of one transport (a unix-socket connection the daemon
itself owns), so every new transport, and every hop, has to re-invent it:
the HTTP API could not, and a gateway would have to *emulate* it by holding a
detached lease on the worker and renewing it on the client's behalf. Two
liveness mechanisms (daemon-initiated heartbeat, client-initiated renew), a
`capabilities.heartbeat` flag, a held-only TTL backstop, and a `BAD_REQUEST`
for a `ttlMs` on the wrong mode are all costs of that one coupling.

## Decision

1. **There is one kind of lease.** Every lease has `ttlMs` and `expiresAt`.
   The only thing that keeps a lease alive is a client-initiated
   `lease.renew` arriving before `expiresAt`. This holds on the unix socket,
   over HTTP, over MCP, and through a gateway alike, because renew is an
   ordinary operation on every transport.
2. **"Held" is a client policy, not a daemon mode.** The CLI's default
   `simlock lease` still prints one result line and stays alive; what it does
   while alive is renew on a timer (one third of the TTL) and release on
   exit, parent death, or a catchable signal. A transient renew failure is
   retried on the next tick; a renew answered `UNKNOWN_LEASE` means the
   daemon already ended the lease, and a holder exits the way a `lease-lost`
   push ends it. `--detach` means "do not stay
   alive"; the lease it returns is not a different kind of lease. MCP does
   the same for the session's lease. Its renew timer is what drives its
   reconnect: when the timer fires against a dead client, the session
   reconnects to a daemon that is already listening and renews, instead of
   waiting for the next tool call and letting its own lease expire while
   idle. The timer never launches a daemon; auto-launch stays a tool-call
   concern (an operator's `daemon stop` must not be undone by an idle
   session), so a lease held across a stopped daemon expires unless the
   daemon is back before its deadline. Nothing in the daemon knows or cares
   which policy a client follows.
3. **Connection close means nothing to a lease.** The daemon keeps no
   per-connection lease state and releases nothing when a connection
   closes, on any transport. A holder that dies without releasing
   (`SIGKILL`, a crash, a lost machine) keeps its device until `expiresAt`,
   which is why the default TTL is short. One mechanism, no exceptions.
4. **The daemon-initiated heartbeat goes away.** `lease.heartbeat`, the
   `heartbeat` hello capability, `lease.heldTtlBackstopMs`, and
   `lease.heartbeatIntervalMs` are removed. `lease.detachedTtlMs` becomes
   `lease.defaultTtlMs` (renamed in the key set, not aliased: an old key
   warns and is ignored, and its value is not carried over; default 15
   minutes, applied when a request carries no `ttlMs`). A lease records the
   width it was granted with, or last renewed with; a `lease.renew` that
   names no `ttlMs` re-applies that width rather than `lease.defaultTtlMs`,
   so a lease granted for four hours does not shrink to fifteen minutes the
   first time something renews it. A new `lease.maxTtlMs` (default 4 hours)
   caps what a request or renew may ask for; a larger value is
   `BAD_REQUEST`. `mode` on `lease.request` is removed; `ttlMs` is accepted
   on every request.
5. **Lease-scoped pushes stay.** `lease-lost`, `device-unhealthy`, and
   `device-recovered` still go to every live connection whose principal owns
   the lease (ADR 0003 §8), and polling clients still read them from renew's
   `notices`. They are facts about the device, not a liveness channel.

## Consequences

- One code path for expiry, on every frontend; the HTTP gateway's
  "detached-only" special case disappears because there is nothing else.
- A gateway forwards `lease.renew` to the owning worker and needs no
  emulation, no timer, and no per-connection state at all.
- A CLI or MCP holder that exits normally still releases at once, because
  release-on-exit is its own policy. A holder killed with `SIGKILL` or lost
  with its machine no longer frees its device on socket close; the device
  sits until `expiresAt` — at most the lease's own TTL after the last renew:
  `lease.defaultTtlMs` (15 minutes by default) unless the request asked for
  more, never more than `lease.maxTtlMs`. That is the one behaviour change a
  local user can notice, and the price of a single mechanism. A machine-sleep
  or socket hiccup, conversely, no longer costs a held lease.
- The daemon's held-lease bookkeeping (the held set kept for
  release-on-close, ADR 0003 §8) is deleted.
- `lease.granted` loses `mode` and `lease.released` loses the `closed` and
  `orphaned` reasons, since neither concept exists any more. This is a
  deliberate exception to `docs/agent-rules/events.md` rule 6 (additive
  payloads only), taken once while the package is 0.x; `EVENTS.md` notes
  it.
- The HTTP API's "additive evolution only" promise takes the same kind of
  one-off exception, under this ADR's "Breaking for 0.x" consequence below:
  `mode` leaves the lease record the operator routes serialize, and
  `lastRenewedAt` and the stored `ttlMs` arrive on it; a `ttlMs` above
  `lease.maxTtlMs` becomes `400` where it used to be accepted; and the
  `ttlMs` a lease reports is its own width rather than a value the gateway
  remembered per request. `docs/HTTP-API.md` states it where it applies.
- The lease record gains `lastRenewedAt`, set at grant and on every renew,
  replacing the derived `lastHeartbeatAt` decoration — which was computed as
  `ttlDeadline - heldTtlBackstopMs` and has no answer once TTLs are
  per-lease.
- The socket wire moves to protocol 4 with no compatibility shim; under ADR
  0003 §6's honesty rule both sides advertise `{min: 4, max: 4}`.
- `lease.defaultTtlMs` and `lease.maxTtlMs` are validated together at load
  (`defaultTtlMs <= maxTtlMs`, both positive); a violating config fails the
  daemon start, the same way an invalid `lease.*` value already does today.
  Retired keys warn and are ignored.
- Breaking for 0.x: `lease.heartbeat` and `mode` leave the contract;
  three config keys are renamed or removed (`simlock config` warns on the
  old names). `docs/CLI.md`, `docs/CLIENT.md`, `docs/HTTP-API.md`,
  `docs/CONFIGURATION.md`, and `docs/ARCHITECTURE.md` ("Leases") are
  rewritten in the same change.
- `StartupConverger`'s orphan sweep goes away: there are no held leases to
  release at start. Startup restores every lease's TTL timer from its
  persisted deadline, which the detached path already does today.

## Alternatives considered

- **Keep held mode and add a bidirectional session transport (WebSocket)
  for HTTP and the gateway.** Keeps today's semantics exactly, but every
  hop still has to carry the heartbeat, and a gateway still emulates.
  Rejected: it preserves the coupling this ADR exists to remove.
- **TTL-first, but keep the daemon ping where the transport allows it.**
  Two liveness mechanisms to keep consistent, for no behaviour the client
  timer does not already give. Rejected.
- **A `releaseOnDisconnect` request flag** honoured by transports that have
  a connection, so a killed CLI holder frees its device instantly as today.
  Considered and rejected: it reintroduces per-connection lease state in
  the daemon and at every proxy hop, and a second answer to "when does a
  lease end" that HTTP can never give. A short default TTL is the accepted
  trade.

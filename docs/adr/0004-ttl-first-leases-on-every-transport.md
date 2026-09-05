# 0004. TTL-first leases on every transport

- **Status:** Proposed
- **Date:** 2026-09-05
- **Issue:** none yet
- **Supersedes:** nothing (narrows ADR 0003 §8's `lease.heartbeat` push and
  the held/detached split in `docs/CLI.md`)

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
   exit, parent death, or a catchable signal. `--detach` means "do not stay
   alive"; the lease it returns is not a different kind of lease. MCP does
   the same for the session's lease. Nothing in the daemon knows or cares
   which policy a client follows.
3. **Connection close means nothing to a lease.** The daemon keeps no
   per-connection lease state and releases nothing when a connection
   closes, on any transport. A holder that dies without releasing
   (`SIGKILL`, a crash, a lost machine) keeps its device until `expiresAt`,
   which is why the default TTL is short. One mechanism, no exceptions.
4. **The daemon-initiated heartbeat goes away.** `lease.heartbeat`, the
   `heartbeat` hello capability, `lease.heldTtlBackstopMs`, and
   `lease.heartbeatIntervalMs` are removed. `lease.detachedTtlMs` becomes
   `lease.defaultTtlMs` (default 15 minutes, applied when a request carries
   no `ttlMs`) and a new `lease.maxTtlMs` (default 4 hours) caps what a
   request or renew may ask for; a larger value is `BAD_REQUEST`. `mode` on
   `lease.request` is removed; `ttlMs` is accepted on every request.
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
  sits until `expiresAt`, at most `lease.defaultTtlMs` after the last renew
  (15 minutes by default, against today's immediate release). This is the
  one behaviour change a local user can notice, and the price of a single
  mechanism. A machine-sleep or socket hiccup, conversely, no longer costs a
  held lease.
- The daemon's held-lease bookkeeping (the held set kept for
  release-on-close, ADR 0003 §8) is deleted.
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

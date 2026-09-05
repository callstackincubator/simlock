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
   exit, parent death, or signal. `--detach` means "do not stay alive"; the
   lease it returns is not a different kind of lease. MCP does the same for
   the session's lease. Nothing in the daemon knows or cares which policy a
   client follows.
3. **Connection close is an optimization, never the liveness mechanism.**
   `lease.request` gains `releaseOnDisconnect?: boolean` (default `false`).
   A transport that has a connection (unix socket, a gateway's WebSocket)
   releases such leases the moment the connection closes, so a crashed CLI
   holder still frees its device immediately, as today. A transport without
   one (HTTP) ignores the flag. Either way the TTL is what guarantees the
   device comes back.
4. **The daemon-initiated heartbeat goes away.** `lease.heartbeat`, the
   `heartbeat` hello capability, `lease.heldTtlBackstopMs`, and
   `lease.heartbeatIntervalMs` are removed. `lease.detachedTtlMs` becomes
   `lease.defaultTtlMs` (applied when a request carries no `ttlMs`) and a
   new `lease.maxTtlMs` caps what a request may ask for. `mode` on
   `lease.request` is removed; `ttlMs` is accepted on every request.
5. **Lease-scoped pushes stay.** `lease-lost`, `device-unhealthy`, and
   `device-recovered` still go to every live connection whose principal owns
   the lease (ADR 0003 §8), and polling clients still read them from renew's
   `notices`. They are facts about the device, not a liveness channel.

## Consequences

- One code path for expiry, on every frontend; the HTTP gateway's
  "detached-only" special case disappears because there is nothing else.
- A gateway forwards `lease.renew` to the owning worker and needs no
  emulation, no timer, and no per-connection state beyond
  `releaseOnDisconnect`.
- A held CLI lease that loses its daemon connection without a crash (machine
  sleep, socket hiccup) now survives until `expiresAt` instead of being
  released by the daemon on close — unless it asked for
  `releaseOnDisconnect`, which the CLI's default policy does. Behaviour for
  the CLI is therefore unchanged; the mechanism is not.
- Breaking for 0.x: `lease.heartbeat` and `mode` leave the contract;
  three config keys are renamed or removed (`simlock config` warns on the
  old names). `docs/CLI.md`, `docs/CLIENT.md`, `docs/HTTP-API.md`,
  `docs/CONFIGURATION.md`, and `docs/ARCHITECTURE.md` ("Leases") are
  rewritten in the same change.
- `StartupConverger`'s orphan sweep no longer has "held" leases to release
  at start; it restores every lease's TTL timer and lets `releaseOnDisconnect`
  leases whose connection cannot exist any more expire on their deadline —
  or, simpler and equivalent in effect, releases them immediately as
  `orphaned`, since a daemon restart provably closed every connection.
  The second is the proposal.

## Alternatives considered

- **Keep held mode and add a bidirectional session transport (WebSocket)
  for HTTP and the gateway.** Keeps today's semantics exactly, but every
  hop still has to carry the heartbeat, and a gateway still emulates.
  Rejected: it preserves the coupling this ADR exists to remove.
- **TTL-first, but keep the daemon ping where the transport allows it.**
  Two liveness mechanisms to keep consistent, for no behaviour the client
  timer does not already give. Rejected.

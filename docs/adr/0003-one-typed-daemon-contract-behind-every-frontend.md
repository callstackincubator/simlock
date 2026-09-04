# 0003. One typed daemon contract behind every frontend

- **Status:** Accepted
- **Date:** 2026-09-03
- **Issue:** [#71](https://github.com/callstackincubator/simlock/issues/71)
  (part of [#70](https://github.com/callstackincubator/simlock/issues/70))
- **Supersedes:** nothing

## Context

Simlock has three frontends: the CLI, the stdio MCP server, and the HTTP
gateway. A fourth is coming: a supported programmatic client that a host
process (agent-device) uses to allocate devices over the unix socket without
spawning a command.

The daemon side is sound. It owns all state, serializes every decision, and
exposes role interfaces (`LeaseCommands`, `QueueControl`, `CapacityReader`,
`CatalogReader`) that any frontend can call. The frontend side is not ready
for a fourth client:

- **The socket protocol is the real API, but it is untyped.** The client
  connection is `request(type: string, payload: unknown): Promise<unknown>`.
  Request and response shapes exist only inside the daemon's request switch
  and in hand-written parsers duplicated across the CLI and MCP.
- **HTTP bypasses the protocol.** It calls the core in-process and
  re-implements status assembly, device and lease decoration, duration
  parsing, and error mapping. It has already diverged: the socket path
  applies `config.downloads.policy`, the HTTP path passes `allowDownload`
  through unclamped.
- **Frontends hold state that belongs to the daemon.** HTTP owns an in-memory
  lease-request registry and a notice buffer. The CLI writes `tokens.json`
  directly while the daemon reads it. The MCP session caches its owned lease
  and answers `lease_status` from that cache.
- **The socket has no roles.** Any local connection can release any lease,
  nuke, or stop the daemon. HTTP has agent and operator roles. An "admin
  client" split would be cosmetic unless the daemon enforces it.

The host integration also needs things the socket cannot express today: one
connection holding many leases (the core allows one lease per requester id),
cancelling a request without closing the connection (which would drop every
other lease on it), and progress pushes attributable to a request when
several are in flight.

## Decision

### 1. Every operation is declared once, as a contract

A contract module defines each daemon operation as one record: name, role,
input schema, output schema, optional authorization hook. Schemas are zod;
public TypeScript types are inferred from them. The same module declares
every server push and the closed set of error codes with their typed details.

```ts
const releaseLease = defineOperation({
  name: "lease.release",
  role: "agent",
  input: z.object({ leaseId: z.string() }),
  output: z.object({ leaseId: z.string() }),
  authorize: ownsLease((input) => input.leaseId),
});
```

The contract imports nothing from `core`, `daemon`, or `drivers`. Core
domain records (`DeviceRecord`, `LeaseRecord`, `LeaseGrant`) stay private;
the daemon maps them onto contract types in exactly one place. This is what
keeps private types out of the public package surface.

### 2. One dispatcher serves every transport

Request handling leaves `DaemonServer`. A transport-independent dispatcher
takes an operation name, a raw input, and a session, and in order: parses
the input, rejects a session whose role is below the operation's role with
`FORBIDDEN`, runs the `authorize` hook, parks on startup readiness, calls the
handler, parses the output. Handlers never see a role check or a raw payload.

The socket server becomes framing plus session lifecycle. The HTTP app
becomes routing plus a bearer-token-to-session adapter and calls the same
dispatcher in-process. Nothing routes HTTP through the loopback socket; the
parity comes from the shared dispatcher, not from a shared wire.

Consequences that fall out for free: HTTP's copies of status, decoration,
error mapping, `requireAuth`, and `requireOwnership` are deleted; the
download policy applies to HTTP; an HTTP request during startup waits like a
socket request instead of being refused.

### 3. Roles live in the daemon

Two roles: `agent` and `admin`. The operation matrix:

| Operation | Role | Ownership |
|---|---|---|
| `catalog.get`, `status.get` | agent | none |
| `lease.request`, `lease.cancel` | agent | requester defaults to principal |
| `lease.renew`, `lease.release`, `lease.list` | agent | own leases; admin sees/acts on all |
| `lease.heartbeat` | agent | this connection's held leases |
| `doctor.run` with `fix: false` | agent | none |
| `doctor.run` with `fix: true` | admin | none |
| `lease.release-all`, `list.get` | admin | none |
| `cleanup.run`, `nuke.run`, `config.get`, `daemon.stop` | admin | none |
| `events.replay`, `events.subscribe` | admin | none |
| `token.create`, `token.list`, `token.revoke` | admin | none |

`doctor.run` without fix stays agent-visible because the issue asks for it;
it is read-only but shells out per device, and the docs say so.

### 4. Principal and requester are different things

Socket identity is **cooperative**. Every socket peer is the same OS user,
which is the real trust boundary; ownership checks protect against accidents
(releasing a guessed lease id), not against a hostile local process. The
docs say this plainly.

- The **principal** is declared once at `hello` and is fixed for the
  connection's lifetime. A request cannot name a different principal than
  the connection it arrived on. For HTTP the principal is the token's
  requester id.
- `lease.request` takes an optional **`requesterId`** defaulting to the
  principal. The core's one-lease-per-requester rule stays keyed on requester
  id, so one connection (the host, acting as a proxy for many agents) holds
  many leases by passing one requester id per session.
- A lease persists an **`ownerId`** set from the session principal. Renew,
  release, and list compare `ownerId` to the principal; admin bypasses.
  Records written before this field exist load with `ownerId` equal to
  `requesterId`.

### 5. Admin authority comes from a credential in the handshake, never from the socket

`hello` carries the protocol range, capabilities, the principal, and an
optional `credential`. The reply carries the negotiated version, the
daemon's range, the daemon version, and the **resolved role**, so a client
can assert it got what it asked for. A missing or wrong credential fails the
handshake with `ADMIN_AUTHENTICATION_FAILED` before any other request runs.

Two credentials are accepted, checked in this order:

1. **An operator token** from the token store (`simlock token create --role
   operator`). This is what a supervisor process uses; it is long-lived and
   revocable.
2. **The per-start admin secret.** On every start the daemon generates a
   random secret, keeps only its hash in memory, and writes the secret to
   `admin.token` in its data directory. Written atomically *after* the socket
   claim succeeds (temp file, claim, rename), with owner-only permissions set
   at creation, removed on graceful stop. A daemon that loses the start race
   never touches the real file. `hello` verifies against memory, so a
   credential can be checked before the file lands and before convergence.

The credential travels only inside the `hello` payload. It is never logged,
never returned by any operation, never read from a config file the daemon
loads, and never inferred from the socket path or a client-declared role.

How a caller supplies it, in resolution order: the `credential` connect
option (programmatic client), `--token` (CLI), `SIMLOCK_ADMIN_TOKEN` (CLI),
the local `admin.token` file (CLI). The daemon does not care which.

**The CLI connects as admin whenever the local file is readable**, falling
back to an agent session with a stderr notice when it is not (a different OS
user, or a daemon still writing the file — the CLI retries the read briefly
first). This is what keeps `simlock lease --detach` followed by
`simlock release <id>` working across two invocations with pid-derived
identities; the CLI is the operator interface. `SIMLOCK_AGENT_ID` and
`--agent-id` still set the requester id for the one-lease rule and for
attribution. `simlock lease` output includes the resolved role.

### 6. Protocol versions are negotiated as ranges, and mismatch is never auto-repaired

Client and daemon each advertise `{min, max}` and negotiate the highest
overlap. Ranges are honest: they widen only when a compatibility path is
actually kept. Mismatch fails `hello` with:

```ts
{ code: "PROTOCOL_VERSION_UNSUPPORTED",
  client: { min, max }, daemon: { min, max }, daemonVersion }
```

The common case is `npm upgrade` while an old daemon still runs with leases
held. The client **never** restarts the daemon on mismatch — that would
release every held lease on the machine. The error names the running daemon
version and says to run `simlock daemon stop` when idle. So that the upgrade
path exists at all, **`daemon.stop` is a frozen exception**: the daemon
accepts it at any protocol version it has ever spoken.

Compatibility with protocol 2: the new client sends both the legacy exact
`protocolVersion` and the range, so an old daemon answers with its legacy
mismatch code, which the client maps to the error above with the daemon range
reported as `{2, 2}`. A new daemon treats a bare number as `{n, n}`.

### 7. One error class, closed codes, typed details

`SimlockError` has a `code` from the contract's closed union, `details`
typed per code (so `code === "REQUESTER_ALREADY_LEASED"` narrows
`details.existingLeaseId`), and a `kind` of `transport` (unavailable,
connection lost, startup timeout), `protocol` (version, handshake, bad
request, forbidden, authentication), or `domain` (capacity, unknown lease,
runtime missing, …). CLI exit codes and HTTP status codes are columns of the
same error table, not second mappings.

A code the client does not know — a newer daemon — wraps as
`UNKNOWN_DAEMON_ERROR` with the raw code and message in `details`. This is
the one place forward compatibility beats strictness; throwing a parse
failure there would turn every daemon-side error addition into a client
crash. Codes and details are contract; message text is not.

### 8. Pushes carry their correlation key and route by owner

Three push families, each with its key required by schema:

- **Request-scoped** (`progress`): carries the originating request's frame
  id. The client routes it to that call's `onProgress` and drops pushes for
  ids it no longer tracks.
- **Lease-scoped** (`lease-lost`, `device-unhealthy`, `device-recovered`):
  carries the lease id, and is pushed to **every live connection whose
  principal owns the lease, in either mode**. Today these reach only the
  held-lease connection; a detached holder learned of a crash only when a
  renew failed. The held set is kept only for release-on-close.
- **Connection-scoped** (`lease.heartbeat`, `event` with a subscription id).

A push can arrive before the response to the request that caused it. The
client de-duplicates by lease id and never fires `onLeaseLost` for a release
the same client asked for. The HTTP notice buffer stays, because a polling
client has no connection to push to, but it consumes the owner-routed facts
rather than subscribing to the bus itself.

### 9. Three additions to the operation set

- **`lease.cancel`** — cancels this principal's pending request by requester
  id. Cancellation no longer means closing the connection.
- **`lease.list`** — the principal's own leases (all leases for admin). This
  is what makes MCP a stateless view: `lease_status` is one call to it.
- **`ttlMs` on `lease.request`** — initial TTL for a detached lease. Supplying
  it for a held lease is `BAD_REQUEST`; held TTL is the backstop, not the
  caller's to shorten. This deletes HTTP's renew-immediately-after-grant hack.

### 10. The client is one connection, and does not reconnect or retry

`simlock/client` exports `connectSimlock`; `simlock/admin` exports
`connectSimlockAdmin`, which extends it. The split is by import path; the
enforcement is the daemon's role check.

The client owns nothing but its connection. When the connection dies, every
in-flight call rejects with `DAEMON_CONNECTION_LOST`, `onLeaseLost` fires for
each held lease with reason `daemon-connection-lost`, and the client is dead.
Reconnect policy is a frontend concern: MCP keeps its lazy reconnect because
its process outlives a connection; the CLI needs none; the host has its own
supervisor. No automatic retry, not even for reads — a shared retry is a
trap the moment it touches a mutation. "Reconnecting never implicitly
acquires a device" is easy to prove for a client that cannot reconnect.

The one stateful thing the client does is **abort**. `requestLease` takes an
`AbortSignal`:

- before the request is sent → reject `CANCELLED`, nothing sent;
- while queued → `lease.cancel`, wait for the original to reject, surface
  `CANCELLED`;
- while device work is in flight → `lease.cancel` answers not-cancellable;
  the client waits for the outcome, **releases a grant immediately**, and
  rejects `CANCELLED`, so the caller never holds a lease it abandoned;
- after the grant resolved → ignored.

True cancellation during provisioning is deliberately out of scope here and
is recorded as a follow-up in `known-pitfalls.md`.

### 11. Frontends render the contract, and nothing else

Simlock is 0.x; this release is breaking (0.3.0).

- **CLI `--json` output and stderr event lines are contract values serialized
  as-is.** The snake_case renderings (`lease`, `expires_at_ms`, …) go. Exit
  codes stay — they are the one thing shell scripts genuinely branch on.
  Human-readable `status` and `catalog` formatting stays.
- **MCP tool schemas are derived from the contract schemas.** Tool names
  stay. MCP keeps only connection lifecycle (lazy reconnect, tool-call
  serialization) and its MCP-only relays (progress notifications, lease-lost
  and device-health notifications). Its `LEASE_NOT_OWNED` guard is deleted;
  the daemon's owner rule answers `FORBIDDEN`.
- **HTTP bodies are contract types.** The lease-request resource envelope
  and `Idempotency-Key` stay HTTP-specific until
  [#72](https://github.com/callstackincubator/simlock/issues/72) moves
  durable requests into the core.
- **`token create|list|revoke` become daemon operations.** The daemon is
  the only owner of `tokens.json`. **`config set`** stays a file write
  (config is daemon *input*, read at start) but validates the merged file
  through the config loader before writing. **`daemon logs`** stays a file
  read; it must work when the daemon is dead.
- **`daemon status`** distinguishes socket absent from handshake refused
  using error `kind`, instead of reporting "stopped" on any error.

### 12. Testing

Full contract coverage at the dispatcher: one suite per operation against a
fake driver and a scripted session, covering parsing, role rejection,
ownership, and error codes. One smoke test per frontend (CLI, MCP, HTTP,
client); frontends are now serialization, and re-walking every operation
through each transport would test nothing new. Client unit tests against a
scripted connection for the issue's four conditions: invalid payload
rejected, mismatch rejected before any request, agent cannot call admin
methods, bad credential causes zero requests after `hello`.

## Consequences

- Adding an operation is one contract declaration plus one handler.
  Forgetting a role is a type error. The client methods, MCP tool schemas,
  and HTTP bodies follow from the declaration.
- The socket wire moves to protocol 3 with no compatibility shim; nobody
  consumes it yet.
- One new persisted field on the lease record (`ownerId`) with a load-time
  default.
- The HTTP tracker and notice buffer remain the known stateful leftovers in
  a frontend. #72 removes the tracker by moving durable, idempotent lease
  requests into the core registry; this ADR prepares the seam (the dispatcher
  is the only place requests are handled) but does not do that work. #72
  stays open, re-scoped to core durability and idempotency.
- Sequencing, one PR each, each leaving the tree working: (1) contract
  module and range negotiation, daemon validates inputs; (2) dispatcher,
  roles, `ownerId`, credential handshake, HTTP moved onto the dispatcher;
  (3) typed client, package exports, client tests; (4) CLI and MCP moved onto
  the client, raw parsers and hand-built payloads deleted, token operations
  into the daemon; (5) docs, smoke tests, changelog.

## Alternatives considered

- **Real identity on the socket (agent tokens for every connection).**
  Rejected: kills the zero-setup local experience for the one trust boundary
  that already exists (same OS user).
- **HTTP as a client of the loopback socket.** Rejected: an extra hop and a
  second serialization for no parity gain once both go through the
  dispatcher.
- **Rejecting requests during convergence with `DAEMON_NOT_READY`.**
  Rejected: pushes a retry loop into every client, and auto-start depends on
  the first request simply waiting. Parking already blocks safely; a
  `wait: false` client option can be added later without a protocol change.
- **A class per error.** Rejected: every frontend's mapper grows a branch per
  class, which is the duplication being removed.
- **A self-healing client.** Rejected: see 10.
- **Keeping today's CLI/MCP/HTTP output shapes.** Rejected: 0.x, and one
  vocabulary everywhere is the point.

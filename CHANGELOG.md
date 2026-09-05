# Changelog

## Unreleased

ADR 0004 (`docs/adr/0004-ttl-first-leases-on-every-transport.md`): there is
now one kind of lease, on every transport. A lease carries a TTL, and the
only thing that keeps it alive is a client-initiated `lease.renew` arriving
before the deadline — on the unix socket, over HTTP, over MCP, and through a
gateway alike. Held mode is gone as a daemon concept; staying alive to renew
and releasing on exit is now the CLI's and the MCP session's own policy over
an ordinary lease. This is a breaking release for the contract, three config
keys, and one user-visible behaviour; see below.

### ⚠ BREAKING CHANGES

- **Contract:** `lease.heartbeat` is removed as an operation, and
  `heartbeat` is removed as a `hello` capability. The daemon never pushes to
  a client to prove liveness any more; nothing replaces it, because
  `lease.renew` already did the job on every transport that has one.
- **`mode` leaves the contract.** `lease.request` no longer accepts it, and
  the lease record no longer carries it. `ttlMs` is now accepted on **every**
  `lease.request` — supplying it used to be `BAD_REQUEST` for a held lease —
  and is capped at `lease.maxTtlMs`, above which a request or a renew is
  `BAD_REQUEST` rather than silently clamped. A caller reading
  `lease.mode` off a grant now reads `undefined`, which is falsy, not an
  error; there is nothing to branch on any more.
- **`lastHeartbeatAt` on the lease record is now `lastRenewedAt`**, set at
  grant and on every renew. `simlock status` renders it as "last renewed".
- **Socket protocol:** moves to protocol 4 with no compatibility shim; the
  range a daemon and client advertise is `{min: 4, max: 4}`. A
  version-mismatched client fails `hello` with
  `PROTOCOL_VERSION_UNSUPPORTED` and never restarts the daemon — run
  `simlock daemon stop` once it's idle. `daemon.stop` remains a frozen
  exception, accepted at any protocol version the daemon has ever spoken.
- **Config:** `lease.detachedTtlMs` is renamed `lease.defaultTtlMs` (same
  15-minute default; a config file still carrying the old key is read as the
  new one, with a warning naming it). `lease.heldTtlBackstopMs` and
  `lease.heartbeatIntervalMs` are removed — `simlock config` warns about
  them and ignores them, like any other unrecognized key. New:
  `lease.maxTtlMs`, default 4 hours. See
  `docs/CONFIGURATION.md#retired-lease-keys`.
- **A holder killed with `SIGKILL` keeps its device until the TTL expires.**
  The daemon keeps no per-connection lease state and releases nothing when a
  connection closes, on any transport — so a holder that dies without
  running its own release path (`SIGKILL`, a crash, a lost machine) holds its
  device until `expiresAt`, at most `lease.defaultTtlMs` after its last
  renew, against today's immediate release on socket close. A holder that
  exits normally, is `SIGTERM`ed, or whose parent dies still releases at
  once, because that is its own policy. This is the one behaviour change a
  local user notices, and it is the accepted price of a single mechanism;
  the reverse case improves, as a machine sleep or a socket hiccup no longer
  costs a live holder its device. `lease.defaultTtlMs` and `--ttl` bound it
  — see `docs/known-pitfalls.md`.
- **`simlock daemon stop` no longer releases leases**, and there is no
  orphaned-lease sweep at daemon startup. Leases persist across a restart and
  the next daemon restores each one's TTL timer from its deadline; one whose
  deadline passed in between expires as soon as a daemon is there to expire
  it.
- **Events:** `lease.granted`'s payload drops `mode`. `lease.released` loses
  the `closed` and `orphaned` reasons — a closing connection is not a release
  and never was a fact worth emitting, and there is no startup sweep to
  produce an orphan. `explicit`, `killed`, and `device-lost` remain.
- **`simlock/client`:** `onLeaseLost` no longer fires with reason
  `daemon-connection-lost` when a connection dies. The lease is still
  granted and still yours — reconnect and renew it, or let its TTL run out.
  `onConnectionLost` is what reports the dead connection; `onLeaseLost` now
  only ever reports a lease the daemon actually ended.

### Features

- **cli:** `simlock lease` (without `--detach`) renews its own lease at one
  third of the remaining TTL for as long as it runs, and releases on exit,
  parent death, or `SIGINT`/`SIGTERM`. `--detach` prints the grant and exits;
  the lease it leaves behind is the same kind of lease, and renewing it is
  the caller's job.
- **cli:** `simlock lease --ttl <duration>` sets a lease's initial TTL in
  place of `lease.defaultTtlMs`, capped by `lease.maxTtlMs`.
- **daemon:** one expiry path for every frontend — startup restores every
  lease's TTL timer from its persisted deadline, and the held-lease
  bookkeeping kept for release-on-close is deleted along with the
  `StartupConverger` orphan sweep that existed to clean up after it.
- **config:** `lease.maxTtlMs` bounds what any caller may ask for, so one
  client cannot pin a device for a day by naming a large `ttlMs`.

### Documentation

- record ADR 0004 as **Accepted — not yet implemented**
  (`docs/adr/0004-ttl-first-leases-on-every-transport.md` and
  `docs/adr/README.md`): the documentation below describes the decided end
  state, and the code catches up to it.
- rewrite the lease model across `docs/CLI.md`, `docs/CLIENT.md`,
  `docs/HTTP-API.md`, `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md`
  ("Leases", the frontend topology, and startup convergence),
  `docs/EVENTS.md`, `docs/ABOUT.md`, and `README.md`; record the SIGKILLed
  holder and re-frame the reparented-holder fix around renew timers in
  `docs/known-pitfalls.md`.

## [0.3.0](https://github.com/callstackincubator/simlock/compare/v0.2.0...v0.3.0) (2026-09-03)

ADR 0003 (`docs/adr/0003-one-typed-daemon-contract-behind-every-frontend.md`):
every daemon operation is now declared once, as a typed contract
(`src/contract/`), served by one shared dispatcher to all four frontends —
the CLI, the stdio MCP server, the HTTP gateway, and a new programmatic
client (`simlock/client`, `simlock/admin`, see `docs/CLIENT.md`). This is a
breaking release for every frontend's wire vocabulary; see below.

### ⚠ BREAKING CHANGES

- **CLI:** `--json` output and stderr event lines (`lease`, `daemon`, and
  progress/push lines) are now the contract's own values, serialized as-is.
  The old snake_case renderings (`expires_at_ms`, `estimated_boot_ms`,
  `eta_seconds`, …) are gone. Exit codes are unchanged; human-readable
  `status`/`catalog` formatting is unchanged.
- **MCP:** tool names are unchanged, but every tool's input/output schema is
  now derived from the contract instead of hand-declared. Two field changes
  need every caller updated:
  - `lease_simulator`'s `timeout_seconds` is now `timeoutMs`. The input
    schema is `.strict()`, so a caller still sending the old key gets a
    hard `BAD_REQUEST`, not a silent failure. The real hazard is a caller
    that renames the field but not its value: `{"timeoutMs": 30}` meaning
    "30 seconds" is valid input, and times out ~1000× _sooner_ than
    intended (`QUEUE_TIMEOUT`, exit 10) rather than later — update the
    field name **and** multiply the value by 1000.
  - The top-level `slim: boolean` on a grant is gone; it is now
    `device.featureProfile` (`"full" | "reduced" | undefined`). A caller
    still checking `result.slim === true` silently never sees a
    feature-loss signal again.

  See `docs/CLI.md#simlock-mcp` for the full callout.

- **Socket protocol:** moves to protocol 3 with no compatibility shim. A
  version-mismatched client fails `hello` with
  `PROTOCOL_VERSION_UNSUPPORTED` and never restarts the daemon — run
  `simlock daemon stop` once it's idle. `daemon.stop` is a frozen exception,
  accepted at any protocol version the daemon has ever spoken (still
  admin-role gated).
- **`lease.request`'s wire shape** drops the legacy `device`/`os` field
  aliases and the nested `request` wrapper the pre-0.3.0 daemon accepted;
  an old client sending them now gets `BAD_REQUEST` instead of those keys
  silently vanishing.
- **HTTP:** `GET /v1/leases/:id` and `GET /v1/leases/:id/events` now return
  `404 UNKNOWN_LEASE` instead of `403 FORBIDDEN` for another requester's
  still-live lease — there is no dispatcher operation for a single-lease
  read to defer to, so both fall back to `lease.list`'s own filter, which
  does not distinguish "unknown" from "not yours" either. `POST
/v1/leases/:id/renew` and `DELETE /v1/leases/:id` dispatch
  `lease.renew`/`lease.release` directly instead and keep answering `403
FORBIDDEN` for the same case, matching the socket transport exactly — see
  `docs/HTTP-API.md#get-v1leasesid`.
- **`token create|list|revoke`** are now daemon operations (admin role) —
  the daemon is the sole owner of `tokens.json`. `config set` and
  `daemon logs` remain file operations.

### Bug Fixes

- **http:** `allowDownload` is now clamped through `config.downloads.policy`
  the same way the socket protocol always was — HTTP previously passed a
  client-supplied `allowDownload` through unclamped, so a `"never"` policy
  could be bypassed over HTTP even though the socket already blocked it.
- **http:** a request arriving before the daemon's startup convergence
  finishes now waits on the shared dispatcher's readiness gate instead of
  being refused — the HTTP gateway's listener starts at socket-claim time
  rather than only after convergence completes.
- **cli:** filter lease-lost pushes by this connection's own lease id, so a
  second CLI invocation sharing a principal (e.g. a detached lease from an
  earlier `--detach`) doesn't misreport a push for a lease this process
  never held.
- **contract:** restrict `lease.cancel` to the calling principal (only
  admin may cancel on another principal's behalf).
- **daemon:** require the admin role for `daemon.stop`.
- **http:** `GET /v1/lease-requests/{id}` and friends now answer `404
UNKNOWN_LEASE_REQUEST`, not `404 UNKNOWN_REQUEST` — the latter collided
  with the contract's own `UNKNOWN_REQUEST` (a 400 protocol error for an
  unrecognized operation name), so a client branching on `error.code` alone
  could not tell "no such request id" from "no such operation".

### Features

- **contract:** declare every daemon operation once — name, role, input/
  output zod schema, optional `authorize` hook — with public TypeScript
  types inferred from the schemas (`src/contract/`).
- **daemon:** move request handling into one transport-independent
  dispatcher (`src/daemon/dispatcher.ts`) serving both the unix socket and,
  in-process, the HTTP gateway.
- **daemon:** negotiate protocol versions as `{min, max}` ranges instead of
  an exact match.
- **daemon:** resolve `hello`'s admin credential — an operator token or the
  daemon's per-start `admin.token` secret — before any other request on the
  connection runs; wire the admin handshake and route lease-scoped pushes to
  every live connection sharing a lease's owner, not just the holder.
- **core:** persist a lease's `ownerId`, distinct from `requesterId` (ADR
  0003 §4) — the session principal a lease was granted to, vs. the
  per-request attribution a connection may vary. `lease.released`/
  `lease.expired` now carry `ownerId` in their event payloads.
- **client:** add the typed daemon client core (`simlock-client`) and
  publish it as the `simlock/client` and `simlock/admin` package entry
  points — one connection, no reconnect, no retry, with `AbortSignal`-driven
  cancellation on `requestLease` (see `docs/CLIENT.md`).
- **cli, mcp:** move onto the typed client, deleting the hand-built request
  payloads and raw response parsers both frontends carried before.
- **http:** move HTTP onto the shared dispatcher, deleting its own copies
  of status assembly, decoration, error mapping, and ownership checks.

### Documentation

- record ADR 0003 (`docs/adr/0003-one-typed-daemon-contract-behind-every-frontend.md`).
- add `docs/CLIENT.md` for the new programmatic client; document the
  contract/dispatcher architecture and the cooperative-identity security
  model in `docs/ARCHITECTURE.md`; document the breaking changes above in
  `docs/CLI.md` and `docs/HTTP-API.md`; record true-cancellation-during-
  provisioning and the HTTP tracker/notice-buffer stateful leftovers in
  `docs/known-pitfalls.md`.

## [0.2.0] and earlier

Not tracked in this file — see `git log` for history before this changelog
was introduced.

# Changelog

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
  - `lease_simulator`'s `timeout_seconds` is now `timeoutMs` — **a unit
    change, not just a rename.** A caller that keeps the old field name
    under the new key silently waits 1000× too long before timing out; this
    is the single highest-risk change in this release.
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
- **HTTP:** `GET /v1/leases/:id` (and `renew`/`events`/`DELETE` on the same
  resource) now returns `404 UNKNOWN_LEASE` instead of `403 FORBIDDEN` for
  another requester's lease — see `docs/HTTP-API.md#get-v1leasesid`.
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

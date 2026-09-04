# HTTP API reference

Part of the user manual: the network-facing control-plane API a remote agent
uses instead of the CLI/MCP frontends' unix socket. It is off by default
(`http.enabled: false` — see [CONFIGURATION.md](CONFIGURATION.md)) and, once
enabled, binds `127.0.0.1` unless configured otherwise. Reaching it from
another machine is the operator's own tunnel (Tailscale, cloudflared, a
reverse proxy) — Simlock does no TLS termination in v1, and `Authorization`
is required on every route regardless of how it's reached, loopback included.

The gateway calls the exact same in-process `Dispatcher` the unix socket
calls (ADR 0003 §2) — not a second copy of role/ownership logic, and not a
loopback hop through the socket either. Every route that maps onto a daemon
operation gets the same input parsing, role check, `authorize`/ownership
hook, and startup-readiness parking a socket request gets, from that one
shared instance. This is also why a fix on the socket side (the download
policy, startup-readiness parking, error mapping) lands on HTTP for free —
see [ARCHITECTURE.md](ARCHITECTURE.md#contract-dispatcher-and-roles-adr-0003)
for how it fits together, and the two bug fixes called out below for what
this actually changed.

## Leases are detached-only over HTTP

Every lease granted through this API is **detached**: TTL-bound, kept alive
by `POST /v1/leases/:id/renew`, never by a held connection. HTTP is
stateless — "held lease = live connection" does not survive a real network —
so there is no held mode here and no WebSocket held-mode emulation. A lease
that stops renewing expires via the same TTL machinery `simlock lease
--detach` uses; the device is reclaimed normally.

Acquisition is an async resource, not a blocking call: `POST
/v1/lease-requests` returns as soon as the request exists (queued, or already
past that), and the client polls, long-polls, or streams its progress to a
terminal state. No route blocks on device work in flight.

## Authentication

Every route requires `Authorization: Bearer slk_<secret>` except `GET
/v1/healthz`. Missing or unrecognized tokens are `401 UNAUTHENTICATED`.

Tokens are minted and managed with `simlock token` (see [CLI.md](CLI.md)) —
a local, no-daemon-round-trip command, like `config`. Each token record is
`{ id, role, label?, createdAt }`, hashed at rest in `~/.simlock/tokens.json`
(SHA-256; the plaintext secret is shown exactly once, at `create`, and never
persisted). The token id doubles as the requester identity over HTTP: unlike
the CLI's `--agent-id`/`SIMLOCK_AGENT_ID`, identity is never client-declared
here, so the one-lease-per-requester rule keys off which token authenticated
the request, not anything the request body says.

Two roles:

| Role | Can |
|---|---|
| `agent` | catalog, status, its own lease requests and leases |
| `operator` | everything `agent` can, plus every other requester's leases/devices, event replay/stream, and releasing any lease |

A valid token with the wrong role for a route is `403 FORBIDDEN`, not `401` —
distinct from an unrecognized token. Reaching another requester's own
resource (a lease/request an `agent` token didn't create) is the same `403`,
enforced per-resource rather than as a role gate.

## Endpoints

All routes are under `/v1`, JSON bodies both ways, additive evolution only —
new fields, never removed or repurposed ones.

### `GET /v1/healthz`

Unauthenticated liveness for tunnels/load balancers. → `200 {"ok":true}`.

### `GET /v1/status`

Role: `agent`. The same view `simlock status --json` reads: daemon health
(`starting`/`running`), managed/running capacity per platform, active
leases, managed devices, queue depth.

### `GET /v1/catalog?platform=ios|android`

Role: `agent`. Exactly `simlock catalog --json`. Read-only; never triggers a
download.

### `POST /v1/lease-requests`

Role: `agent`. Enqueues a device request.

```json
{
  "platform": "ios",
  "device": "iPhone 17 Pro",
  "os": "26.5",
  "ttlMs": 900000,
  "timeoutMs": 300000,
  "noWait": false,
  "allowDownload": false,
  "full": false
}
```

`platform` and `device` are required; `os` defaults to the newest installed
runtime; `ttlMs` defaults to `lease.detachedTtlMs`; `timeoutMs` (optional) is
enforced daemon-side so a vanished client can't hold a queue slot forever.
`full` (optional, default `false`) opts this request out of iOS slim mode —
platform-neutral in shape, but only the iOS driver acts on it (as "do not
slim"); Android ignores it. A `full: true` request never matches, and never
shares a pool key with, a slim device, so it can wait for a fresh device to
provision or force a re-provision of one already running, even while slim
devices sit idle in the warm pool. See [CONFIGURATION.md](CONFIGURATION.md)
for what slim mode disables.

`allowDownload` is now clamped through `config.downloads.policy` the same
way the socket protocol always was (**bug fix, 0.3.0**): before this
release, HTTP passed a client-supplied `allowDownload` straight through
unclamped, so a `"never"` policy could still be bypassed over HTTP even
though it already blocked the same thing on the socket. Both frontends now
go through the one shared dispatcher, so there is only one place left to get
this wrong.
An `Idempotency-Key` header (at most 200 characters) makes a replay of the
same key, from the same requester, return the original request resource
instead of double-queueing — held in memory with a TTL, so a replay after a
daemon restart creates a fresh request (see
[Lifecycle semantics](#lifecycle-semantics) below).

With `allowDownload: true` the `201` is returned immediately, before the
request is even admitted — resolving a downloadable runtime can take minutes,
so progress (and any admission failure, `REQUESTER_ALREADY_LEASED` included)
surfaces on the request resource instead of on the `POST` itself.

→ `201`, `Location: /v1/lease-requests/{id}`:

```json
{ "request": { "id": "req_7d1a", "state": "queued", "queuePosition": 2, "createdAt": "2026-09-01T09:12:00Z" } }
```

A rejection that lands before any device work is claimed for the request
fails the `POST` itself instead of the client having to poll to learn about
it: `409 REQUESTER_ALREADY_LEASED` (names the existing lease id), `422` for
an unknown model / missing runtime / no driver, `503 NO_CAPACITY` (with
`Retry-After`) when `noWait` is set. Anything that fails once device work is
already in flight surfaces as the request resource's terminal `failed` state
instead — see the state list below.

### `GET /v1/lease-requests/{id}`

Role: `agent` (its own requests; `operator` sees all). Poll the request.
`?wait=<seconds>` long-polls: returns as soon as the state changes, else
once `wait` elapses. `wait` is capped at 60 seconds — a larger value is
clamped, not rejected, and the poll simply returns (unchanged) sooner than
asked; re-poll to keep waiting.

States: `queued | reclaiming | provisioning | booting | granted | failed |
cancelled`, carrying `queuePosition` (`queued`) or `etaSeconds`
(`reclaiming`/`provisioning`/`booting`) where the stage has one. Terminal
`granted` embeds the [lease object](#the-lease-object); terminal `failed`
embeds `{ code, message }`.

### `GET /v1/lease-requests/{id}/events`

Role: `agent` (ownership as above). Server-Sent Events stream of the same
progress objects, one event per state change, ending with `granted` or
`failed`. A `: keepalive` comment every ~15s keeps idle tunnels from closing
the stream.

### `DELETE /v1/lease-requests/{id}`

Role: `agent` (ownership as above). Cancel a pending request.

→ `204` if it was still cancellable (no device work claimed for it yet).
`409 REQUEST_NOT_CANCELLABLE` once device work is in flight, or the request
already reached a terminal state — the body names the lease id if it was
`granted` (release that instead). `404 UNKNOWN_LEASE_REQUEST` if unknown.

### The lease object

```json
{ "lease": {
    "id": "lse_9f2c", "requestId": "req_7d1a",
    "platform": "ios", "device": "iPhone 17 Pro", "os": "26.5",
    "udid": "ABCD-...", "deviceId": "dev_1a2b",
    "createdAt": "2026-09-01T09:14:07Z",
    "expiresAt": "2026-09-01T09:29:07Z", "ttlMs": 900000,
    "dataPlane": null, "slim": true
} }
```

`dataPlane` is **reserved** and always `null` in this version: driving the
leased device remotely (the data plane) is a separate, not-yet-implemented
concern — see [Not implemented](#not-implemented) below. It is in the schema
now so its arrival is additive rather than a breaking shape change.

`slim` is `true` when the granted device had its feature set reduced (iOS
slim mode applied and the request did not carry `full: true`), `false`
otherwise — always `false` for Android. It lets a client explain a
feature-loss failure (missing push notification, Spotlight result,
StoreKit sheet, universal link, or system picker) instead of misreading it
as a bug.

### `GET /v1/leases/{id}`

Role: `agent` (own lease; `operator` any). Re-fetches the lease — a client
that restarts mid-lease recovers its state instead of leaking the lease.
`404 UNKNOWN_LEASE` both once it has expired or been released, and for
another requester's own, still-live lease: this route (and `GET
/v1/leases/{id}/events` below) has no dispatcher operation to defer to for a
single-lease read, so it resolves the lease the same way `lease.list`'s
handler already filters leases — to the session's own set, admin sees all —
and an id outside that set simply isn't in the list. `404` covers "doesn't
exist" and "not yours" identically, the same way `lease.list` itself does
not distinguish them.

`POST /v1/leases/{id}/renew` and `DELETE /v1/leases/{id}` are different:
both dispatch `lease.renew`/`lease.release` directly, so another requester's
own, still-live lease answers `403 FORBIDDEN` from those two routes — the
same answer the socket transport gives, via the same operation's `ownsLease`
authorize hook. (0.3.0 briefly had all four routes answering `404` here;
that overcorrected the lease-*request* routes' old `403` and is why renew
and release were moved off the `lease.list`-filtered lookup — see
`docs/known-pitfalls.md`.)

This is different again from the lease-*request* routes below
(`/v1/lease-requests/{id}` and friends), which are still HTTP's own resource
and still answer `403 FORBIDDEN` for another requester's request — that
envelope stays HTTP-specific until
[#72](https://github.com/callstackincubator/simlock/issues/72).

`expiresAt` is always the authoritative deadline. After a **daemon** restart
the gateway no longer remembers a per-request `ttlMs`, so the payload reports
the lease's mode default (the interval a body-less renew applies from then
on) and may omit `requestId`; schedule renewals from `expiresAt`, not from
`ttlMs`.

### `POST /v1/leases/{id}/renew`

Role: `agent` (own lease). Body `{ "ttlMs": 900000 }` (optional; defaults to
the lease's own mode default). Resets the deadline to now + ttl.

→ `200 { "leaseId": "lse_9f2c", "expiresAt": "...", "notices": [] }`

`notices` carries device-health facts observed since the previous renew for
this lease — `{"event":"device_unhealthy"}`,
`{"event":"device_recovered","attempts":1}` — so a polling-only client
learns its device blinked without holding a stream open.

### `GET /v1/leases/{id}/events`

Role: `agent` (own lease). Server-Sent Events for live health pushes on this
lease: `device_unhealthy`, `device_recovered`, `lease_lost` (ends the
stream). The same facts held mode relays on stderr today.

### `DELETE /v1/leases/{id}`

Role: `agent` (own lease); `operator` may release any lease.

→ `202 { "released": true, "device": { "id": "dev_1a2b", "state": "reclaiming" } }`

The lease is gone the moment this responds; the driver-side purge continues
in the background (existing release semantics — see "Release hands the
purge off" in [ARCHITECTURE.md](ARCHITECTURE.md)), hence `202`, not `200`.

### Operator routes

Role: `operator` for all four.

- `GET /v1/leases` — every active lease (`simlock list --leases`).
- `GET /v1/devices` — every managed device, with state and
  `transitionAgeMs` (`simlock list --devices`).
- `GET /v1/events?since=<duration>` — replay from the in-memory business-event
  ring buffer (`simlock events`).
- `GET /v1/events/stream` — Server-Sent Events follow of the event bus
  (`simlock events --follow`).

## Errors

Every failure is the same shape the daemon protocol uses:

```json
{ "error": { "code": "NO_CAPACITY", "message": "..." } }
```

| HTTP | Codes |
|---|---|
| 400 | `BAD_REQUEST` (malformed body, bad query param, validation) |
| 401 | `UNAUTHENTICATED` (missing or unrecognized token) |
| 403 | `FORBIDDEN` (role doesn't permit the route; a `/v1/lease-requests/*` route whose request belongs to another requester; or `POST /v1/leases/{id}/renew`/`DELETE /v1/leases/{id}` naming another requester's still-live lease) |
| 404 | `UNKNOWN_LEASE_REQUEST` (unknown request id), `UNKNOWN_LEASE` (unknown lease id, expired/released, **or `GET /v1/leases/{id}`/`GET /v1/leases/{id}/events` naming another requester's lease** — see [`GET /v1/leases/{id}`](#get-v1leasesid)) |
| 409 | `REQUESTER_ALREADY_LEASED` (body names the existing lease id), `REQUEST_NOT_CANCELLABLE` (body names the lease id if the request had already been granted) |
| 422 | `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER` |
| 503 | `NO_CAPACITY` (only with `noWait: true`; response carries `Retry-After`) |

## Lifecycle semantics

- **Daemon restart.** In-flight lease requests are in-memory and do not
  survive, same as the socket protocol's queue today. A client polling a
  request id from before the restart gets `404 UNKNOWN_LEASE_REQUEST`; if its
  grant had actually landed before the crash, the persisted detached lease
  answers a retried `POST` with `409 REQUESTER_ALREADY_LEASED` naming the
  lease id, which the client then `GET`s to recover its state. This is the
  documented recovery loop: `404` → re-request → (maybe) `409` → `GET`.
- **Idempotency keys** are in-memory with a TTL; a replay after that window
  (including across a restart) creates a fresh request rather than erroring
  — the `409` above is the real backstop against a double grant, not the
  idempotency cache.
- **Startup.** The gateway's listener now starts the moment the daemon
  claims its socket — the same instant the unix socket itself starts
  accepting connections, before startup convergence (`doctor.reconcile()`,
  running-capacity convergence) has run (**bug fix, 0.3.0**: the gateway
  used to start only once convergence had already finished, so it could not
  observe or need this). A request that arrives before convergence completes
  now waits on the shared dispatcher's readiness gate exactly like a socket
  request, instead of being refused — every route but the routes that don't
  dispatch at all (`GET /v1/healthz`) can block briefly on a cold start.
- **Shutdown.** `simlock daemon stop` closes the HTTP listener (and any open
  connection, in-flight SSE streams included) before releasing held leases
  or tearing down the lease engine, so no HTTP request can run against a
  stopping daemon.

## Not implemented

- `POST /v1/doctor` and `POST /v1/cleanup` — not part of this version; may
  land as a follow-up.
- `nuke` is absent from the HTTP surface entirely, deliberately: a
  remote fleet-wipe endpoint is a footgun even behind auth. It stays
  SSH/local-only (`simlock nuke`).
- `dataPlane` on the lease object is reserved and always `null` — driving
  the leased device remotely is tracked separately (the agent-device
  integration work), not in this version.
- MCP-over-HTTP, in-process TLS, and multi-host brokering are all out of
  scope for this version too (a per-lease `dataPlane.baseUrl` already leaves
  room for the last one, once it exists).

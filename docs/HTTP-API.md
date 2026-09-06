# HTTP API reference

Part of the user manual: the network-facing control-plane API a remote agent
uses instead of the CLI/MCP frontends' unix socket. It is off by default
(`http.enabled: false` — see [CONFIGURATION.md](CONFIGURATION.md)) and, once
enabled, binds `127.0.0.1` unless configured otherwise. Reaching it from
another machine is the operator's own tunnel (Tailscale, cloudflared, a
reverse proxy) — Simlock does no TLS termination in v1, and `Authorization`
is required on every route regardless of how it's reached, loopback included.

The HTTP frontend calls the exact same in-process `Dispatcher` the unix
socket calls (ADR 0003 §2) — not a second copy of role/ownership logic, and not a
loopback hop through the socket either. Every route that maps onto a daemon
operation gets the same input parsing, role check, `authorize`/ownership
hook, and startup-readiness parking a socket request gets, from that one
shared instance. This is also why a fix on the socket side (the download
policy, startup-readiness parking, error mapping) lands on HTTP for free —
see [ARCHITECTURE.md](ARCHITECTURE.md#contract-dispatcher-and-roles-adr-0003)
for how it fits together, and the two bug fixes called out below for what
this actually changed.

## Leases are TTL-bound, the same as everywhere else

A lease granted through this API is the same kind of lease `simlock lease`
gets on the unix socket ([ADR
0004](adr/0004-ttl-first-leases-on-every-transport.md)): it carries a TTL, it
is kept alive by `POST /v1/leases/:id/renew` arriving before `expiresAt`, and
nothing else keeps it alive. There is no connection-liveness mode to be the
odd one out from — HTTP is stateless, and so is the lease model now, on every
transport. Closing a connection, dropping a tunnel, or losing the client
releases nothing; a lease that stops renewing expires at `expiresAt` and its
device is reclaimed normally.

That is the whole liveness story here, and it is worth stating plainly what
it costs: a client that vanishes without calling `DELETE /v1/leases/:id`
holds its device until `expiresAt` — at most the lease's own TTL after its
last renew: `lease.defaultTtlMs` unless the request asked for more, never
more than `lease.maxTtlMs`. Ask for a shorter `ttlMs` on the request if you
want a tighter bound.

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

Three roles:

| Role | Can |
|---|---|
| `agent` | catalog, status, its own lease requests and leases |
| `operator` | everything `agent` can, plus every other requester's leases/devices, event replay/stream, releasing any lease, and the worker routes on a gateway |
| `worker` | open an uplink at `GET /v1/uplink`, and nothing else |

A valid token with the wrong role for a route is `403 FORBIDDEN`, not `401` —
distinct from an unrecognized token. Reaching another requester's own
resource (a lease/request an `agent` token didn't create) is the same `403`,
enforced per-resource rather than as a role gate.

`worker` is a **join token** (ADR 0005), minted on a gateway and put in a
worker's `gateway.token`. The exclusivity runs both ways and is checked before
any session exists: a `worker` token is `403` on every `/v1` route but
`/v1/uplink`, and an `agent` or `operator` token is `403` *at* `/v1/uplink`.

## Endpoints

All routes are under `/v1`, JSON bodies both ways, additive evolution only —
new fields, never removed or repurposed ones. [ADR
0004](adr/0004-ttl-first-leases-on-every-transport.md) breaks that rule once,
under its "Breaking for 0.x" consequence, and each break is called out where
it applies below:

- **`mode` is gone** from the lease record the operator routes serialize
  (`GET /v1/status`, `GET /v1/leases`), and **`lastRenewedAt` and the stored
  `ttlMs` are new on it** — there is one kind of lease now, and the fields
  that described the split went with it.
- **A `ttlMs` above `lease.maxTtlMs` is `400 BAD_REQUEST`** where it used to
  be accepted.
- **The `ttlMs` a lease reports is the lease's own width**, not a value the
  HTTP frontend remembered per request.

Routes, status codes, and every other field are unchanged.

### `GET /v1/healthz`

Unauthenticated liveness for tunnels/load balancers. → `200 {"ok":true}`.

### `GET /v1/status`

Role: `agent`. The same view `simlock status --json` reads: a `daemon` block,
managed/running capacity per platform, active leases, managed devices, queue
depth.

The daemon block carries `health` (`starting`/`running`) and **`mode`**
(`"worker" | "gateway"`), the one field that tells a client which kind of
daemon answered — always `"worker"` in this version:

```json
{ "daemon": { "health": "running", "mode": "worker" } }
```

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
runtime; `ttlMs` defaults to `lease.defaultTtlMs` and is `400 BAD_REQUEST`
above `lease.maxTtlMs`; `timeoutMs` (optional) is enforced daemon-side so a
vanished client can't hold a queue slot forever. `full` (optional, default
`false`) opts this request out of iOS slim mode — platform-neutral in shape,
but only the iOS driver acts on it (as "do not slim"); Android ignores it. A
`full: true` request never matches, and never shares a pool key with, a slim
device, so it can wait for a fresh device to provision or force a re-provision
of one already running, even while slim devices sit idle in the warm pool. See
[CONFIGURATION.md](CONFIGURATION.md) for what slim mode disables.

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

`expiresAt` is always the authoritative deadline, and `ttlMs` is always the
lease's own width — the TTL it was granted with, or last renewed with when a
renew carried one. The daemon stores it on the lease record, so it survives a
**daemon** restart along with the deadline and the restored TTL timer; a
payload served after a restart may still omit `requestId`, which was only
ever gateway-side. Schedule renewals from `expiresAt` rather than from
`ttlMs` all the same: the deadline is the fact, the width is how far the next
body-less renew will push it.

### `POST /v1/leases/{id}/renew`

Role: `agent` (own lease). Body `{ "ttlMs": 900000 }` — optional, and
omitting it re-applies the lease's own `ttlMs` rather than
`lease.defaultTtlMs`, so a lease keeps the width it was granted with. A
`ttlMs` above `lease.maxTtlMs` is `400 BAD_REQUEST`; one below it changes the
lease's width from this renew on. Either way the deadline resets to now + ttl,
regardless of how much time was left. This is the only thing that keeps a
lease alive.

→ `200 { "leaseId": "lse_9f2c", "expiresAt": "...", "notices": [] }`

`notices` is an HTTP-side convenience, not part of the socket contract's
`lease.renew` response: `LeaseNoticeBuffer` (`src/http/notices.ts`) collects
the owner-routed device-health facts a socket client would have received as
pushes, and drains them here. It carries the facts observed since the
previous renew for this lease — `{"event":"device_unhealthy"}`,
`{"event":"device_recovered","attempts":1}` — so a polling-only client
learns its device blinked without holding a stream open.

### `GET /v1/leases/{id}/events`

Role: `agent` (own lease). Server-Sent Events for live health pushes on this
lease: `device_unhealthy`, `device_recovered`, `lease_lost` (ends the
stream). The same facts a running `simlock lease` relays on stderr. Losing
this stream tells you nothing about the lease — it is still yours until
`expiresAt`; reconnect, or read the health facts from `renew`'s `notices`.

`lease_lost` is the one fact `notices` cannot carry: it ends the lease, so
there is nothing left to renew and nothing to drain the buffer on. A polling
client learns it the other way round — the next `POST /v1/leases/{id}/renew`
against an ended lease answers `404 UNKNOWN_LEASE`.

### `POST /v1/leases/{id}/exec`

Role: `agent` (own lease; `operator` any). Runs one `simctl`/`adb` command
**on the machine that owns the device** and streams its output back. This is
what makes a leased device drivable from here at all: every other way of
reaching one assumes the caller shares that machine's filesystem.

```json
{ "tool": "simctl", "args": ["list", "devices"], "stdin": "y\n" }
```

`tool` names a driver passthrough — `simctl` or `adb` on the machines this
version runs on. The contract does not close that set; the drivers installed
there do, and one they do not claim is `422 UNKNOWN_PASSTHROUGH_TOOL`. `args`
are passed through unchanged. The daemon
resolves them through the same driver passthrough `simlock simctl` /
`simlock adb` use — the same scoping flags, and the same refusal list, so a
verb the driver will not proxy (`simctl delete`, `adb kill-server`, …) is
`422 PASSTHROUGH_REFUSED` here too and nothing is spawned for it. Nothing else
about the arguments is parsed, and the *device* is named by them, not by the
lease: the lease id is the ownership proof.

`stdin` (optional) is written to the command once and the pipe is then closed.
There is no pseudo-terminal, so line-oriented commands work and full-screen or
interactive ones do not — a bare `adb shell`, which *is* the interactive shell,
is refused (`422 PASSTHROUGH_REFUSED`) rather than left to hang on a pipe until
the timeout.

`requesterId` (optional) names the agent this command is being run *for*, and
is honoured **only for an `operator` token**. Identity is otherwise never
client-declared here (see [Authentication](#authentication)): an `agent`
token's own `requesterId` is dropped, and that token is authorized against the
lease it holds, exactly as it is for renew and release. An operator token is
held to this field instead of getting the usual operator bypass — it must name
the requester the lease was granted to, or the call is `403 FORBIDDEN`. That is
what lets a future gateway proxy many agents over one operator credential
without any of them reaching another's device.

→ `200`, `Content-Type: text/event-stream`, the same SSE shape
`/v1/lease-requests/{id}/events` uses. One event per chunk of output as it is
written, then exactly one terminal event:

```
event: output
data: {"stream":"stdout","chunk":"== Devices ==\n"}

event: output
data: {"stream":"stderr","chunk":"No devices found\n"}

event: exit
data: {"exitCode":0}
```

`chunk` is whatever the command wrote, decoded as UTF-8 and forwarded
unsplit — not a line, not a frame. Output is streamed and never buffered by
the daemon, so there is no size cap and the first chunk arrives while the
command is still running; a client that wants lines assembles them itself. A
`: keepalive` comment every ~15s keeps idle tunnels open, as elsewhere.

A failure that lands **before the command is spawned** is answered as an
ordinary JSON error with its own status instead of a stream: `403 FORBIDDEN`
for another requester's lease (dispatched through the operation's own
ownership hook, like renew and release) and for an `agent` token that sent a
`requesterId` at all, `404 UNKNOWN_LEASE` for an id that names none,
`400 BAD_REQUEST` for a malformed body, `422 PASSTHROUGH_REFUSED` for a refused
verb, `422 UNKNOWN_PASSTHROUGH_TOOL` for a tool no driver on that machine
claims.

The status commits at the **spawn**, not at the first byte: the moment the
child process exists the response is `200` and the stream is open, even if the
command has not written anything yet (`simctl install` on a large bundle says
nothing for a while, and a client should not have to guess whether that
silence means the request was accepted). Everything after that point arrives
as a terminal event instead:

```
event: error
data: {"error":{"code":"EXEC_TIMEOUT","message":"..."}}
```

`EXEC_TIMEOUT` (`504`) is the daemon killing a command that outran
`exec.timeoutMs` (ten minutes by default, see
[CONFIGURATION.md](CONFIGURATION.md)). It is reported instead of the exit code
the kill produced, because "we stopped it" and "it failed" are different
answers. Disconnecting does **not** kill the command — the daemon simply stops
writing its output, the same way closing a connection releases no lease; the
timeout is what bounds it.

Paths in `args` resolve on the daemon's filesystem
(`{"tool":"simctl","args":["install","booted","/build/MyApp.app"]}` needs that
path to exist *there*). Getting a file onto that machine is not part of this
API in this version — see [Not implemented](#not-implemented).

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

On a **gateway** all four answer for the whole fleet: leases and devices carry
a `workerId`, and the event stream carries every worker's republished events
(also with a `workerId` in the payload) alongside the gateway's own
`worker.*` facts.

## Gateway mode (ADR 0005)

A daemon started with `config.mode: "gateway"` serves this same API for a
fleet rather than one machine. Everything above still applies — same routes,
same auth, same error shapes — with three differences.

**`GET /v1/status` and `GET /v1/catalog` aggregate.** Status returns the shape
a worker returns, with capacity summed over the connected workers, `workerId`
on every device and lease, `daemon.mode: "gateway"`, and an additive `workers`
array of worker views. Catalog is the union of the connected workers'
catalogs, each model and runtime annotated with `modelWorkers` /
`runtimeWorkers` — which workers have it.

**Worker routes** (role `operator`), registered only in gateway mode — on a
worker these paths are `404`, because a worker has no worker registry:

| Route | Answers |
|---|---|
| `GET /v1/workers` | `{"workers":[...]}` — every worker view |
| `POST /v1/workers/{id}/drain` | `{"workerId":"…","drained":true}` |
| `DELETE /v1/workers/{id}/drain` | `{"workerId":"…","drained":false}` |
| `DELETE /v1/workers/{id}` | `{"workerId":"…","removed":true\|false}` |

A worker view is `{ id, label?, connection, drained, lastSeenAt, health?,
version?, protocol?, capacity?, downloads?, queueDepth?, leases, devices,
catalog }`. `connection` is `connected`, `disconnected` (the uplink closed;
the view keeps its last-known state until every lease on it has expired and
`gateway.disconnectedRetentionMs` has passed), or `incompatible` (the uplink
is open but `hello` found no overlapping protocol range — `protocol` then
carries both). Drain and undrain answer `404 UNKNOWN_WORKER` for an id with no
view; removing a *connected* worker is `409 WORKER_CONNECTED`, while removing
one the gateway has already forgotten answers `{"removed":false}`.

**`GET /v1/uplink`** — the WebSocket upgrade a worker dials (`Authorization:
Bearer <join token>`, plus `x-simlock-worker-id` and an optional
`x-simlock-worker-label` header). It is not a JSON route: it upgrades to a
WebSocket carrying the daemon protocol, over which the *gateway* is the
protocol client. Authentication happens at the upgrade, before any WebSocket
exists — `401` for a missing or unrecognized token, `403` for a real token of
another role, `404` for any other path — so an unauthorized peer never reaches
the protocol at all. A worker's `gateway.url` is the gateway's **base** URL;
the worker derives this path itself.

**What a gateway refuses.** `POST /v1/lease-requests` and the lease lifecycle
routes answer `501 UNSUPPORTED_IN_GATEWAY_MODE` until fleet routing lands;
`driver.passthrough`-backed routes and the per-machine maintenance operations
(`nuke`, `cleanup`, `doctor`) answer it permanently — they act on one
machine's devices and stay per-worker.

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
| 409 | `REQUESTER_ALREADY_LEASED` (body names the existing lease id), `REQUEST_NOT_CANCELLABLE` (body names the lease id if the request had already been granted), `WORKER_CONNECTED` (body names the `workerId`) |
| 422 | `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER`, `PASSTHROUGH_REFUSED` (a `device.exec` verb the driver will not proxy, a bare `adb shell` included), `UNKNOWN_PASSTHROUGH_TOOL` (no driver claims that tool here) |
| 501 | `UNSUPPORTED_IN_GATEWAY_MODE` (body names the `operation`) |
| 503 | `NO_CAPACITY` (only with `noWait: true`; response carries `Retry-After`), `WORKER_UNREACHABLE` (body names the `workerId`) |
| 504 | `EXEC_TIMEOUT` (a `POST /v1/leases/{id}/exec` command outran `exec.timeoutMs` and was killed; arrives as a terminal `error` event instead if output had already started) |

`404` also covers `UNKNOWN_WORKER` (body names the `workerId`) on the worker
routes. Where an error carries typed details, they are inlined beside `code`
and `message` — details are contract, message text is not.

## Lifecycle semantics

- **Daemon restart.** In-flight lease requests are in-memory and do not
  survive, same as the socket protocol's queue today. A client polling a
  request id from before the restart gets `404 UNKNOWN_LEASE_REQUEST`; if its
  grant had actually landed before the crash, the persisted lease
  answers a retried `POST` with `409 REQUESTER_ALREADY_LEASED` naming the
  lease id, which the client then `GET`s to recover its state. This is the
  documented recovery loop: `404` → re-request → (maybe) `409` → `GET`.
- **Idempotency keys** are in-memory with a TTL; a replay after that window
  (including across a restart) creates a fresh request rather than erroring
  — the `409` above is the real backstop against a double grant, not the
  idempotency cache.
- **Startup.** The HTTP listener now starts the moment the daemon claims its
  socket — the same instant the unix socket itself starts accepting
  connections, before startup convergence (`doctor.reconcile()`,
  running-capacity convergence) has run (**bug fix, 0.3.0**: it used to start
  only once convergence had already finished, so it could not observe or need
  this). A request that arrives before convergence completes
  now waits on the shared dispatcher's readiness gate exactly like a socket
  request, instead of being refused — every route but the routes that don't
  dispatch at all (`GET /v1/healthz`) can block briefly on a cold start.
- **Shutdown.** `simlock daemon stop` closes the HTTP listener (and any open
  connection, in-flight SSE streams included) before tearing down the lease
  engine, so no HTTP request can run against a stopping daemon. Stopping the
  daemon does not release anything: leases persist, and the next daemon
  restores each one's TTL timer from its deadline. A lease whose deadline
  passed while no daemon was running expires as soon as one is.

## Not implemented

- `POST /v1/doctor` and `POST /v1/cleanup` — not part of this version; may
  land as a follow-up.
- `nuke` is absent from the HTTP surface entirely, deliberately: a
  remote fleet-wipe endpoint is a footgun even behind auth. It stays
  SSH/local-only (`simlock nuke`).
- `dataPlane` on the lease object is reserved and always `null`. Running
  commands against a leased device is no longer what it was reserved for --
  `POST /v1/leases/{id}/exec` does that, over this same API -- so what is left
  behind it is the byte-heavy half: live screen streaming, port forwarding,
  interactive TTYs. None of that is in this version.
- **File transfer.** A command that names a path runs against the daemon's
  filesystem, and there is no route that puts a file there. An `.app` or an
  `.apk` arrives out of band (a shared volume, a CI checkout on that machine)
  in this version.
- MCP-over-HTTP and in-process TLS are out of scope for this version too.
  Multi-host brokering is no longer on this list: it is [ADR
  0005](adr/0005-gateway-and-worker-modes.md)'s gateway mode, above.

# HTTP API reference

Part of the user manual: the network-facing control-plane API a remote agent
uses instead of the CLI/MCP frontends' unix socket. It is off by default
(`http.enabled: false` — see [CONFIGURATION.md](CONFIGURATION.md)) and, once
enabled, binds `127.0.0.1` unless configured otherwise. Reaching it from
another machine is the operator's own tunnel (Tailscale, cloudflared, a
reverse proxy) — Simlock does no TLS termination in v1, and `Authorization`
is required on every route regardless of how it's reached, loopback included.

This frontend calls the exact same in-process `Dispatcher` the unix socket
calls (ADR 0003 §2) — not a second copy of role/ownership logic, and not a
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

Tokens are minted and managed with `simlock token` (see [CLI.md](CLI.md)).
Since 0.3.0 `token.create|list|revoke` are daemon operations (admin role) and
the daemon is the only process that reads or writes `tokens.json`, so unlike
`config set` these do go through the daemon (ADR 0003 §11). Each token record
is
`{ id, role, label?, createdAt }`, hashed at rest in `~/.simlock/tokens.json`
(SHA-256; the plaintext secret is shown exactly once, at `create`, and never
persisted). The token id doubles as the requester identity over HTTP: unlike
the CLI's `--agent-id`/`SIMLOCK_AGENT_ID`, identity is never client-declared
here, so the one-lease-per-requester rule keys off which token authenticated
the request, not anything the request body says.

Three roles:

| Role | Can |
|---|---|
| `agent` | catalog, status, its own lease requests and leases, `exec` on its own lease |
| `operator` | everything `agent` can, plus every other requester's leases/devices, the worker routes, event replay/stream, and releasing any lease |
| `worker` | open an uplink at [`/v1/uplink`](#get-v1uplink-websocket-upgrade), and nothing else |

A valid token with the wrong role for a route is `403 FORBIDDEN`, not `401` —
distinct from an unrecognized token. Reaching another requester's own
resource (a lease/request an `agent` token didn't create) is the same `403`,
enforced per-resource rather than as a role gate.

The `worker` role is deliberately not a superset or a subset of the other
two, it is disjoint from both. `/v1/uplink` is the one route a join token
opens and the only route it opens: presented on any other `/v1` route it is
`403`, and an `agent` or `operator` token presented at `/v1/uplink` is `403`
just the same. Join tokens are minted with `simlock token create --role
worker` on the **gateway**, and tokens never cross machines — a gateway's
tokens are valid on that gateway and nowhere else ([ADR
0005](adr/0005-gateway-and-worker-modes.md)).

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

[ADR 0005](adr/0005-gateway-and-worker-modes.md) is purely additive on top of
that: the same routes answer identically whether the daemon behind them is a
worker or a **gateway** fronting a fleet of workers, and what it adds are new
routes (`/v1/uplink`, `/v1/workers*`, `POST /v1/leases/{id}/exec`), new
fields (`mode` on status, `workers[]`, `workerId`, `worker` on the lease),
and new error codes. Nothing existing changes shape, and a client that
ignores every one of them keeps working against a gateway unchanged.

### `GET /v1/healthz`

Unauthenticated liveness for tunnels/load balancers. → `200 {"ok":true}`.

### `GET /v1/status`

Role: `agent`. The same view `simlock status --json` reads: daemon health
(`starting`/`running`), managed/running capacity per platform, active
leases, managed devices, queue depth.

The daemon block also carries **`mode`** (`"worker" | "gateway"`), which is
the only field that tells a client which kind of daemon answered. On a
**gateway** the numbers are the fleet's — capacity summed across connected
workers, every gateway-issued and local lease, every device, the gateway
queue's depth — every lease and device carries the **`workerId`** it lives
on, and an additive **`workers`** array carries one
[worker view](#worker-routes) per worker:

```json
{ "daemon": { "health": "running", "mode": "gateway" },
  "workers": [ { "id": "3f81a2c4", "label": "mac-studio-2", "state": "connected", "drained": false } ] }
```

On a worker, `workers` is absent and `workerId` never appears. A client that
reads neither cannot tell the difference, which is the point.

### `GET /v1/catalog?platform=ios|android`

Role: `agent`. Exactly `simlock catalog --json`. Read-only; never triggers a
download. On a **gateway** it is the union of the connected workers'
catalogs, each model and runtime annotated with the workers that have it — so
a model the catalog lists is leasable *somewhere* in the fleet, not
necessarily on every machine in it.

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

A lease issued by a **gateway** — a worker's own lease is the same object
without the `workerId` and `worker` fields:

```json
{ "lease": {
    "id": "3f81a2c4.lse_9f2c", "requestId": "req_7d1a",
    "platform": "ios", "device": "iPhone 17 Pro", "os": "26.5",
    "udid": "ABCD-...", "deviceId": "dev_1a2b",
    "workerId": "3f81a2c4", "worker": { "id": "3f81a2c4", "label": "mac-studio-2" },
    "createdAt": "2026-09-01T09:14:07Z",
    "expiresAt": "2026-09-01T09:29:07Z", "ttlMs": 900000,
    "dataPlane": null, "slim": true
} }
```

`worker` (and the flat `workerId`, which mirrors it for the aggregate lists)
is present when a **gateway** issued the lease and absent from a worker's own
— it says which machine the device lives on, so a client and the console can
show it. `label` is display-only. A worker's network address is deliberately
never here: clients reach the device through the gateway, with
[`POST /v1/leases/{id}/exec`](#post-v1leasesidexec).

The lease `id` names its worker (`<workerId>.<worker's own lease id>`, split
on the **first** `.`), which is how a gateway routes renew, release, and
reads with no state of its own to lose across a restart. A worker id is a
UUID, so a real id reads
`3f81a2c4-9b7d-4e21-8a55-1c0e6f2d7b93.lse_9f2c`; the examples here and
elsewhere in these docs abbreviate it to its first segment for legibility.
**Treat the whole id as opaque** — pass it back verbatim in paths and bodies,
and read `worker.id` when you want the machine.

`dataPlane` is **reserved** and always `null` in this version: streaming a
device's screen, forwarding a port, or opening an interactive TTY is a
separate, not-yet-implemented concern — see [Not
implemented](#not-implemented) below. It is in the schema now so its arrival
is additive rather than a breaking shape change. Running a *command* on the
device is not part of it and does not wait for it: that is `exec`, below.

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
ever HTTP-side. Schedule renewals from `expiresAt` rather than from
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

### `DELETE /v1/leases/{id}`

Role: `agent` (own lease); `operator` may release any lease.

→ `202 { "released": true, "device": { "id": "dev_1a2b", "state": "reclaiming" } }`

The lease is gone the moment this responds; the driver-side purge continues
in the background (existing release semantics — see "Release hands the
purge off" in [ARCHITECTURE.md](ARCHITECTURE.md)), hence `202`, not `200`.

### `POST /v1/leases/{id}/exec`

Role: `agent` (own lease). Runs one `simctl` / `adb` command against the
leased device on the machine that owns it, and streams its output back. This
is what lets a remote agent actually *drive* the device it leased — over
HTTP against a lone worker, and through a gateway to whichever worker holds
the lease, with the same request and the same response either way ([ADR
0005](adr/0005-gateway-and-worker-modes.md)).

```json
{ "tool": "simctl", "args": ["install", "booted", "/tmp/MyApp.app"],
  "stdin": null, "requesterId": null }
```

`tool` is `"simctl"` or `"adb"`; `args` is the argument vector, passed
through unchanged. The daemon that owns the device resolves the command the
same way `simlock simctl` / `simlock adb` do locally — same root scoping
(`--set` for iOS, `-P` for Android, supplied by simlock and refused from the
caller), and the same refusal list for verbs that would change a device's
lifecycle behind the registry's back (`create`/`erase`/`delete`, `shutdown
all`, `runtime delete`, `kill-server`, `emu kill`, …). A refused verb is
`422 PASSTHROUGH_REFUSED` and an unwrapped `tool` is `422
UNKNOWN_PASSTHROUGH_TOOL` — the codes `driver.passthrough` already answers
with, at the status they already carry; `400 BAD_REQUEST` here means a
malformed body, nothing more. One refusal is particular to this route: a bare
`adb shell` with no command is `422 PASSTHROUGH_REFUSED` ("needs a
terminal"), because there is no pseudo-terminal to give it and accepting it
would only stall the stream until the timeout. A gateway in the path parses
none of this: it proxies the call to the owning worker and relays the stream
back unchanged.

`requesterId` (optional) is the same field `lease.request` takes: an
`operator` token may name another requester, an `agent` token may not, and it
defaults to the token's own requester id (ADR 0003 §4). Ownership is checked
on both hops and an admin session does not skip the second — the gateway
checks its own lease index, and the worker compares the forwarded
(namespaced) requester against the lease it actually holds. That second check
is not a formality: the gateway's session on a worker *is* an admin session,
so without it one fleet agent's ownership would rest on the gateway's index
alone.

`stdin` (optional) is a **single string, sent with the request** and written
to the process's stdin, which is then closed. There is no incremental stdin
channel and no pseudo-terminal, so line-oriented commands work and
full-screen ones (`adb shell` as an interactive session) do not.

→ `200`, `Content-Type: text/event-stream` — the same SSE shape
`/v1/lease-requests/{id}/events` already uses. Output is streamed, never
buffered, so there is no size cap on it:

```
event: output
data: {"stream":"stdout","chunk":"Installing...\n"}

event: output
data: {"stream":"stderr","chunk":"warning: ...\n"}

: keepalive

event: exit
data: {"exitCode":0}
```

`output` events carry `stream` (`"stdout"` or `"stderr"`) and a `chunk`, in
the order the process produced them. The stream ends with exactly one
terminal event: `exit` carrying the tool's own `exitCode` (a non-zero one is
the command's answer, not an API failure), or `error` carrying the usual
`{ code, message }` envelope. A `: keepalive` comment every ~15s keeps idle
tunnels from closing a long-running command's stream.

Chunks are UTF-8 text. A command whose output is binary (`simctl io booted
screenshot -` to stdout) is not supported over this route — have it write to
a file on the device's own machine instead.

Failures particular to this route:

- `403 FORBIDDEN` — the lease belongs to another requester (same rule as
  `renew`/`release`), or an `agent` token named a `requesterId` that is not
  its own.
- `404 UNKNOWN_LEASE` — no such lease, or it has expired or been released.
- `422 PASSTHROUGH_REFUSED` — a refused verb, a caller-supplied `--set`/`-P`,
  or a bare `adb shell`. `422 UNKNOWN_PASSTHROUGH_TOOL` for a `tool` outside
  `simctl`/`adb`.
- `400 BAD_REQUEST` — a malformed body.
- `503 WORKER_UNREACHABLE` — a gateway could not reach the worker holding
  the lease.
- `EXEC_TIMEOUT` (`504` in the contract's error table) — the command outlived
  `exec.timeoutMs`, ten minutes by default and worker-side, which is the
  authoritative one because the worker owns the process;
  `gateway.execTimeoutMs` (eleven minutes) is the gateway's backstop for a
  worker that never answers at all, deliberately the longer of the two. On
  *this* route the status never reaches the client — the response is already
  `200` and streaming by the time a command can time out — so it arrives as
  the stream's terminal `error` event. The status is documented anyway, for a
  client mapping the code without a route in front of it.

The artifact a command names has to exist **on the device's own machine**:
`simctl install <path>` and `adb install <apk>` resolve their path there, and
there is no file upload in this version. See
[known-pitfalls.md](known-pitfalls.md).

### `GET /v1/uplink` (WebSocket upgrade)

Role: `worker`. The endpoint a **worker** dials to join a fleet: it opens
one outbound WebSocket to `<gateway.url>/v1/uplink`, presenting
`Authorization: Bearer slk_<join-token>` on the upgrade request along with
its instance id. The gateway verifies the token against its own store and
requires role `worker`; a missing or unrecognized token is `401
UNAUTHENTICATED`, and a valid token of any other role is `403 FORBIDDEN`.
Revoking the token closes the uplink.

This is the fleet's **only** inbound connection. Workers dial out, so a
machine behind NAT, on a laptop, or on a CI runner joins with a URL and a
token and needs no inbound port of its own, and no client ever learns a
worker's address.

What travels over the socket is not a new API: it is the same typed daemon
contract (ADR 0003), with **the gateway as the protocol client**. It sends
`hello`, negotiates the protocol range exactly as over the unix socket, and
then issues ordinary operations (`status.get`, `list.get`, `catalog.get`,
`events.subscribe`, `lease.request`, `device.exec`, …) to the worker's own
dispatcher, exactly as a local admin CLI would. A worker whose range does not
overlap the gateway's is marked `incompatible` and never dispatched to; it
keeps serving its own local clients.

Nothing else about this endpoint is a REST resource: there is no `GET` body,
no polling, and no route to list uplinks. The connection *is* the worker's
liveness signal — [`GET /v1/workers`](#worker-routes) is how you look at it.

### Worker routes

Role: `operator` for all four. They exist on a **gateway**; a worker has no
workers of its own and does not implement the underlying operations at all.

- `GET /v1/workers` — every worker view the gateway currently holds.
- `POST /v1/workers/{id}/drain` — stop dispatching new requests to this
  worker; it keeps the leases it already has.
- `DELETE /v1/workers/{id}/drain` — undrain it, putting it back in rotation.
- `DELETE /v1/workers/{id}` — forget a worker's view.

```json
{ "workers": [ {
    "id": "3f81a2c4", "label": "mac-studio-2",
    "state": "connected", "drained": false,
    "daemonVersion": "0.4.0", "protocol": { "min": 5, "max": 5 },
    "connectedAt": "2026-09-01T09:00:00Z", "lastSeenAt": "2026-09-01T09:14:30Z",
    "capacity": { "ios": { "running": 2, "limit": 4 }, "android": { "running": 0, "limit": 2 } },
    "downloads": { "policy": "on-request" },
    "queueDepth": 0, "leases": 3, "devices": 5
} ] }
```

`downloads.policy` is that worker's own effective policy, read once with
`config.get` when its uplink connects. Routing needs it to know whether a
worker may install a missing runtime at all before sending it a request that
depends on one; it is never an override, since the worker clamps
`allowDownload` through the same policy regardless.

`protocol` is the range that worker negotiated. ADR 0005 moves the wire to
`{min: 5, max: 5}` with no compatibility shim, so a worker from before it
does not overlap and shows as `incompatible` — the ordinary upgrade path, not
a fault.

`state` is `connected`, `disconnected`, or `incompatible`. A worker view is
rebuilt over the uplink and never persisted, so these are current facts, not
a registry: a worker appears by connecting, and there is deliberately no
route that *adds* one.

A **disconnected** worker keeps its last-known view (greyed in the console,
never dispatched to) until an operator removes it or
`gateway.disconnectedRetentionMs` (24 hours) elapses. The clock is held while
the gateway still knows of gateway-issued leases on that worker — forgetting
a worker that holds someone's device is how a lease becomes unroutable — and
that hold ends when the last of those leases passes its deadline, since a
lease nobody can renew is one the worker has expired on its own clock.

`POST /v1/workers/{id}/drain` → `200 { "workerId": "3f81a2c4", "drained":
true }`; `DELETE /v1/workers/{id}/drain` → `200 { "workerId": "3f81a2c4",
"drained": false }`. Both are `404 UNKNOWN_WORKER` for an id the gateway does
not know: draining is an instruction about a specific machine, and silently
succeeding against one that is not there would hide a typo in exactly the
situation — taking a machine out of service — where an operator most needs to
know the instruction landed.

`DELETE /v1/workers/{id}` → `200 { "workerId": "3f81a2c4", "removed": true }`,
or `409 WORKER_CONNECTED` when its uplink is still open — a connected worker
would simply reappear, so drain it and stop it (or revoke its join token)
first. Unknown ids are the one place remove differs: `200 { "removed": false
}`, not `404`, because "forget this worker" is already true of a worker the
gateway has already forgotten — the same reading `token.revoke` gives an
unknown token id.

On a **worker** daemon none of these routes exist: they are not registered at
all, so they answer `404` like any other unrouted path rather than a
gateway-mode refusal. There is nothing for them to act on.

### Operator routes

Role: `operator` for all four.

`DELETE /v1/leases/{id}` with an `operator` token already releases any single
lease, on a gateway as anywhere else. The fleet-wide form of that — the CLI's
`simlock release --all` — releases **only gateway-issued leases**, on every
connected worker, and never a worker's own local leases: the gateway did not
issue those, does not know who is holding them, and taking a local
developer's device away from an endpoint they have never heard of is not an
operator action anyone asked for. A worker it cannot reach is reported as
`WORKER_UNREACHABLE` naming that worker, and the leases on the workers it
could reach are still released — a partial result, said plainly, rather than
an all-or-nothing that leaves the operator guessing.

- `GET /v1/leases` — every active lease (`simlock list --leases`).
- `GET /v1/devices` — every managed device, with state and
  `transitionAgeMs` (`simlock list --devices`).
- `GET /v1/events?since=<duration>` — replay from the in-memory business-event
  ring buffer (`simlock events`).
- `GET /v1/events/stream` — Server-Sent Events follow of the event bus
  (`simlock events --follow`).

On a **gateway** all four are fleet-wide, which is what makes a single
console possible: `/v1/leases` and `/v1/devices` return every connected
worker's, each record carrying the `workerId` it lives on, and the two event
routes carry the workers' republished events (also `workerId`-tagged)
interleaved with the gateway's own `worker.*` and `request.dispatched`
facts.

## Errors

Every failure is the same shape the daemon protocol uses:

```json
{ "error": { "code": "NO_CAPACITY", "message": "..." } }
```

| HTTP | Codes |
|---|---|
| 400 | `BAD_REQUEST` (malformed body, bad query param, validation) |
| 401 | `UNAUTHENTICATED` (missing or unrecognized token) |
| 403 | `FORBIDDEN` (role doesn't permit the route — including a `worker` token on any `/v1` route other than `/v1/uplink`, and an `agent`/`operator` token at `/v1/uplink`; a `/v1/lease-requests/*` route whose request belongs to another requester; or `POST /v1/leases/{id}/renew`/`DELETE /v1/leases/{id}`/`POST /v1/leases/{id}/exec` naming another requester's still-live lease) |
| 404 | `UNKNOWN_WORKER` (`POST`/`DELETE /v1/workers/{id}/drain` naming a worker the gateway does not know), `UNKNOWN_LEASE_REQUEST` (unknown request id), `UNKNOWN_LEASE` (unknown lease id, expired/released, **or `GET /v1/leases/{id}`/`GET /v1/leases/{id}/events` naming another requester's lease** — see [`GET /v1/leases/{id}`](#get-v1leasesid)) |
| 409 | `REQUESTER_ALREADY_LEASED` (body names the existing lease id; fleet-wide on a gateway), `REQUEST_NOT_CANCELLABLE` (body names the lease id if the request had already been granted), `WORKER_CONNECTED` (`DELETE /v1/workers/{id}` while its uplink is open) |
| 422 | `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER`, `PASSTHROUGH_REFUSED` (a refused `exec` verb, a caller-supplied `--set`/`-P`, a bare `adb shell`), `UNKNOWN_PASSTHROUGH_TOOL` |
| 501 | `UNSUPPORTED_IN_GATEWAY_MODE` (an operation that acts on one machine's devices, asked of a gateway) |
| 503 | `NO_CAPACITY` (only with `noWait: true`; response carries `Retry-After`), `WORKER_UNREACHABLE` (a gateway could not reach the worker holding this lease or request) |
| 504 | `EXEC_TIMEOUT` (a `device.exec` command outlived `exec.timeoutMs`) |

Three notes on the ADR 0005 codes.

`WORKER_UNREACHABLE` sits on `503` with `NO_CAPACITY` rather than on `502`,
because its `kind` is `transport` and every other `transport`-kind code in
the contract's table (`DAEMON_STOPPING`, `DAEMON_STARTUP_FAILED`,
`DAEMON_CONNECTION_LOST`) is already a `503`. "Try again shortly, the thing
behind this is not reachable right now" is the same answer in all four cases,
and a client with one retry rule for `transport` should not need a second one
because the unreachable thing happened to be a worker.

`UNSUPPORTED_IN_GATEWAY_MODE` has no route that can produce it *in this
version* — `nuke`, `cleanup`, and `doctor` are absent from the HTTP surface
(see [Not implemented](#not-implemented)) — but the status is fixed now so
adding `POST /v1/doctor` or `POST /v1/cleanup` later is additive rather than
a fresh decision. `501` is also the honest status for it: this is not a
temporary condition to retry past, it is an operation this daemon will never
perform, and `nuke`/`cleanup`/`doctor`/`driver.passthrough` stay per-worker
permanently rather than pending some later fan-out.

`EXEC_TIMEOUT`'s `504` is documented for completeness rather than for the
exec route: `POST /v1/leases/{id}/exec` has already answered `200` and begun
streaming by the time a command can outlive `exec.timeoutMs`, so on that
route it arrives as the stream's terminal `error` event — as does a
`WORKER_UNREACHABLE` that only happens mid-stream. The status is what a
client mapping the code without a route in front of it should use.

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
- **Startup.** The HTTP listener now starts the moment the daemon
  claims its socket — the same instant the unix socket itself starts
  accepting connections, before startup convergence (`doctor.reconcile()`,
  running-capacity convergence) has run (**bug fix, 0.3.0**: it
  used to start only once convergence had already finished, so it could not
  observe or need this). A request that arrives before convergence completes
  now waits on the shared dispatcher's readiness gate exactly like a socket
  request, instead of being refused — every route but the routes that don't
  dispatch at all (`GET /v1/healthz`) can block briefly on a cold start.
- **Gateway restart, and a worker that goes away.** A gateway's queue is
  in-memory too, so a restart loses in-flight lease requests exactly as a
  worker's does — and leases survive it, on their workers, which reconnect on
  their own backoff and let the gateway rebuild every view and its lease
  index. The recovery loop is the same one: `404` → re-request → (maybe)
  `409` → `GET`. While a worker's uplink is down, anything routed to it is
  `503 WORKER_UNREACHABLE`; the gateway never reports a lease as gone before
  the worker says so, and the lease meanwhile runs out its TTL on the
  worker's own clock.
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
- `dataPlane` on the lease object is reserved and always `null` — a
  byte-heavy data plane (live screen streaming, port forwarding, an
  interactive TTY) is tracked separately, not in this version. Running a
  command on the leased device is *not* waiting on it: that is
  [`POST /v1/leases/{id}/exec`](#post-v1leasesidexec), which works over HTTP
  against a lone worker and through a gateway alike.
- **File transfer for `exec`.** A command that names a path resolves it on
  the machine that owns the device; there is no upload route in this version,
  and the seam for a later `device.upload` is left open by design (ADR 0005).
- MCP-over-HTTP and in-process TLS are out of scope for this version too.
  Multi-host brokering is no longer on this list: [ADR
  0005](adr/0005-gateway-and-worker-modes.md) designs it as gateway and
  worker modes, and its routes (`/v1/uplink`, `/v1/workers*`) are documented
  above.

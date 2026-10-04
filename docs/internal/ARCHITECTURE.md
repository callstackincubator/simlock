# Architecture

## Topology

```
agent ──spawns──> simlock CLI ──┐
                                ├─ shared daemon client ──unix socket──> simlock daemon
MCP client ──spawns──> stdio MCP ┘                                      │
                                                                         │
remote agent ──token auth──> HTTP frontend ─same role interfaces────────┤
                                                                     ┌───┼─────────────┐
                                                                     │ core (platform-│
                                                                     │ agnostic)      │
                                                                     │ lease table ·  │
                                                                     │ wait queue ·   │
                                                                     │ registry ·     │
                                                                     │ capacity ·     │
                                                                     │ state machine ·│
                                                                     │ reaper · health│
                                                                     │ monitor · event│
                                                                     │ bus · warm-pool│
                                                                     │ policy         │
                                                                     └─┬─────────┬────┘
                                                                       │ driver  │ driver
                                                                       ▼ interface ▼ interface
                                                                  iOS driver   Android driver
                                                                  (simctl)     (avdmanager/
                                                                                emulator/adb)
```

That is one daemon, owning the devices on one machine — a **worker**, in ADR
0005's vocabulary, and the only shape simlock has today. A **gateway** fronting
several workers is the other one; see [Gateway and worker
modes](#gateway-and-worker-modes-adr-0005) below for that topology.

- **CLI, stdio MCP server, and HTTP frontend**: sibling thin frontends over one
  typed contract (ADR 0003; see "Contract, dispatcher, and roles" below). The
  core never knows which frontend made a request. The CLI and MCP server sit
  over `simlock/client`/`simlock/admin` (the typed daemon client, see
  [CLIENT.md](../CLIENT.md)) and the unix socket; the CLI is the full operator
  interface, and the MCP server intentionally limits its tool surface to
  leasing and releasing for an agent session. The HTTP frontend is different in
  kind, not just transport: it is the one frontend meant to be reached over a
  real network, so it calls the daemon's dispatcher **in-process** — the exact
  same one the socket path calls — rather than going through the unix socket at
  all, and requires a bearer token on every `/v1` route but `GET /v1/healthz`. It
  grants exactly the same TTL-renewed lease every other frontend does (ADR
  0004) — being reachable over a real network is no longer a reason for a
  different lease model, because there is only one. Its listener now starts
  right after the socket claim, the same moment the unix socket itself starts
  accepting connections and before startup convergence runs (`DaemonServer`'s
  `onSocketClaimed` hook, see "Startup: claim first, converge after" below) — a
  bug fix from the pre-ADR HTTP frontend, which started only once convergence had
  already finished and so never needed to park anything. A request that arrives
  before convergence completes now waits on the shared dispatcher's readiness
  gate exactly like a socket request, instead of being refused. See
  [HTTP-API.md](../HTTP-API.md) for the full route reference.
- **Web console** (ADR 0011): a React app in `ui/`, built by Vite into
  `dist/ui` and served by the same HTTP listener at every path outside `/v1`.
  `src/http/server.ts` puts it in front of `app.fetch`, so `app.ts` stays a
  pure request-to-response function and the console never touches the API's
  auth or request log. The console is a client of the HTTP API like any other:
  it reads only `/v1`, with the operator's token, through one fetch helper
  (`ui/src/api.ts`). Its views are listed once, in `ui/src/views/index.tsx`,
  which is both the tab bar and the router's table. Views read data only
  through the live layer (ADR 0013, `ui/src/live/`): `useLiveResource(path)`
  marks a route as one the screen reads, and `LiveConnection` refetches every
  such route on each event from `GET /v1/events/stream` and every second,
  one request per route at a time; it also owns the disconnect, backoff and
  recovery rules and the clock offset behind `useNow()`. The one exception
  is the last hour of events, which is not a route's latest answer: its feed
  (`ui/src/views/event-feed.ts`, behind `useRecentEvents()`) takes each
  event off the stream through the live layer and loads `GET /v1/events`
  itself, for the last hour and for each gap the stream left. The events view
  lists it, and the workers view's lease chart counts back through it.
  Every route still answers whole lists; the console pages them in the
  browser. Every table of a view's items is `DataTable` (`ui/src/table.tsx`, on
  `@tanstack/react-table`), which keeps its page in the URL's query through
  `usePaging` (`ui/src/pager.tsx`); the events feed draws only the rows in
  view, with `@tanstack/react-virtual`. See
  [CONSOLE.md](../CONSOLE.md) for the user's side and
  [DESIGN.md](DESIGN.md) for the style.
- **CLI**: by default it acquires a lease, prints one JSON result line on
  stdout, then stays alive — renewing the lease at one third of the lease's TTL
  and releasing it on exit, parent death, or `SIGINT`/`SIGTERM`. That is the
  CLI's own policy over an ordinary TTL lease, not a daemon mode: the
  connection itself holds nothing (ADR 0004). `--detach` skips the staying
  alive; the lease it prints is the same lease. Progress streams as JSON lines
  on stderr.
- **stdio MCP server**: its process owns one agent session and exposes MCP over
  stdin/stdout. `McpSession` (`src/mcp/session.ts`) holds one `simlock/client`
  connection at a time and does nothing today's typed client does not already
  do (ADR 0003 §11: MCP keeps only "connection lifecycle ... and its MCP-only
  relays"): tool calls are serialized onto it, `lease_status` is one
  `lease.list` call rather than a session-local cache, and a release the
  session does not own surfaces the daemon's own `FORBIDDEN` rather than a
  client-side guard pre-empting it. Like the CLI, the session runs a renew
  timer over its lease and releases it when the process ends — its own policy,
  not something the connection does. Like the CLI, it relays the daemon's
  progress pushes for the in-flight `lease_simulator` request — as MCP
  `notifications/progress` instead of stderr JSON lines, and only when the
  client supplied a progress token. Unlike the CLI, this process outlives any
  single daemon connection: the typed client itself never reconnects (ADR 0003
  §10), so `McpSession` builds a brand new one lazily, once its current client's
  `onConnectionLost` fires. ADR 0004 narrows ADR 0003 §10/§11's lazy-only
  reconnect to two triggers with deliberately different powers:

  - **On a tool call**, as before — auto-starting the daemon exactly as the
    CLI does (`connectWithAutoLaunch`, `src/mcp/connect.ts`), and never on a
    version mismatch or a refused handshake, only on "nothing is listening".
  - **On the renew timer**, which is new: when the timer fires against a
    dead client, the session reconnects to a daemon that is **already
    listening** and renews, instead of waiting for a tool call that may not
    come and letting its own lease expire while the session sits idle. This
    trigger never launches a daemon. Auto-launch stays a tool-call concern
    so an operator's `simlock daemon stop` cannot be undone by an idle
    session, which means a lease held across a stopped daemon expires unless
    the daemon is back before its deadline.

  Either way the lease survives the reconnect untouched — the daemon
  released nothing when the old connection died — so the new client picks
  the same lease back up (`lease.list` tells it which) rather than treating a
  dead connection as a lost device and requesting a second one.
- **Daemon**: owns all state, serializes all decisions. Started on demand,
  reachable over a unix socket.

## Gateway and worker modes (ADR 0005)

`config.mode` selects what a daemon *is*. Everything above describes a
**worker**: the default, and what every simlock daemon was before ADR 0005 —
it owns the devices on one machine. A **gateway** owns no devices at all.
Workers connect *to* it, and it fronts them:

```
                                 ┌──────────────── gateway (mode: "gateway") ─────────────┐
agent / console ──token auth──>  │ HTTP frontend + unix socket                            │
                                 │ GatewayDispatcher  ── worker views ──┐                 │
                                 └──────────────────────────────────────┼─────────────────┘
                                              ▲ one inbound port        │
                                   uplink ────┘  (ws upgrade on         │ status.get, list.get,
                          (worker dials out)     /v1/uplink)            │ catalog.get, config.get,
                                              ▲                         ▼ events.subscribe
             ┌────────────────────────────────┴─────┐   ┌───────────────────────────────┐
             │ worker (mode: "worker", the default) │   │ worker                        │
             │ drivers · registry · capacity · …    │   │ …                             │
             └──────────────────────────────────────┘   └───────────────────────────────┘
```

- **Workers dial out; the gateway never reaches in.** The only inbound port in
  a fleet is the gateway's, so a worker behind NAT, on a laptop, or on a CI
  runner joins with two config keys: `gateway.url` (the gateway's base URL,
  from which `/v1/uplink` is derived) and `gateway.token`, a join token minted
  on the gateway with `simlock token create --role worker`. A `worker`-role
  token opens an uplink and nothing else — it is `403` on every other `/v1`
  route, and an `agent`/`operator` token is `403` at `/v1/uplink`.
- **The uplink carries the existing contract, with the gateway as the protocol
  client.** It is the same newline-delimited JSON framing the unix socket uses,
  upgraded from the gateway's own HTTP listener. The worker's `DaemonServer`
  accepts it as one more connection and grants that session the `admin` role —
  not because of the transport (ADR 0003 §5 forbids that), but because *this
  daemon dialled out*, to the URL in its own config, with the token from that
  same file, which the gateway verified before the connection existed. An
  operator who does not want a gateway administering a machine removes two
  config keys.
- **A gateway is a second implementation of the contract's handlers, not a
  second contract** (`src/gateway/`). Same dispatch pipeline, same operation
  declarations, same role checks; the handlers read *worker views* instead of a
  registry and a lease engine. Every frontend — CLI, MCP, HTTP,
  `simlock/client` — works against a gateway unchanged, because they only ever
  see the contract.
- **A worker view** is what the gateway knows about one worker: id (the
  worker's own `instance.json` identity), label, connection state
  (`connected` / `disconnected` / `incompatible`), daemon health and version,
  capacity per platform, download policy, queue depth, leases, devices,
  catalog (with when it was read this session), host facts, drain state, and a last-seen timestamp. It is rebuilt
  over the uplink — `status.get`, `list.get`, `catalog.get`, `config.get` and
  `events.subscribe` on connect, a refresh of status and devices on every
  worker event about a lease or a device, and a slow periodic tick that also
  re-reads the catalog and config — and never persisted.
  A gateway restart re-derives every view from the workers that reconnect.
- **The uplink is the reachability signal**: no polling. A closed uplink flips
  the view to `disconnected` immediately and keeps its last-known state, so a
  machine that vanished holding a device is still visible. The view is
  forgotten only when every lease on it has passed its deadline *and*
  `gateway.disconnectedRetentionMs` (default 24 h) has elapsed, or when an
  operator runs `simlock worker remove` — which refuses a worker that is still
  connected.
- **Aggregation.** `status.get` on a gateway returns the same shape a worker
  does — capacity summed over connected workers, every device and lease
  carrying a `workerId`, the gateway's own queue depth — plus a `workers`
  array of views and `daemon.mode: "gateway"`. `catalog.get` is the union of
  the connected workers' catalogs, each model and runtime annotated with the
  workers that have it, `modelRuntimes` per model the union of each
  worker's own pairings, `modelAliases` the union per model, and `images`
  the union by runtime, tag, and ABI (ADR 0008 §4). Worker events are republished on the gateway's bus
  with `workerId` added, so `simlock events --follow` against a gateway shows
  the fleet.
- **What a gateway does not do.** It starts no drivers, validates no device
  roots, and runs no reaper, health monitor or capacity strategy; of the
  config it reads only `mode`, `http.*`, `log.*`, `lease.*`, `eventBuffer.*`,
  `eventLog.*` and `gateway.*` (worker-only keys warn and are ignored). It always listens
  on HTTP — that is how agents reach it and what the uplink upgrades from — so
  `http.enabled: false` in gateway mode fails the start rather than being
  silently overridden. `nuke.run`, `cleanup.run`, `doctor.run`,
  `driver.passthrough`, `component.install`, `component.list` and
  `component.remove` answer `UNSUPPORTED_IN_GATEWAY_MODE` permanently: they act on one machine's devices
  or components, and stay per-worker. Installing through a gateway is its own
  gateway-only operation, `worker.install-component`, which names the
  workers (see "Through a gateway" under Components). The lease lifecycle
  (`lease.request`/`renew`/`release`/`cancel`/`release-all`) and `device.exec`
  are forwarded through the fleet's own queue and routing policy (§10-§19,
  `FleetLeaseCoordinator`) rather than answering `UNSUPPORTED_IN_GATEWAY_MODE`;
  reads — `lease.list`, `list.get`, `status.get`, `catalog.get`, `events.*` —
  answer for the whole fleet the same way.
- **The one piece of persisted gateway state** is the drained set
  (`workers.json`, owner-only): drain is an operator's decision about a
  machine, not a fact the machine reports, so it must survive both the
  reconnect an operator is about to cause and a gateway restart.

## Contract, dispatcher, and roles (ADR 0003)

Every daemon operation is declared exactly once, in `src/contract/`: a name
(`lease.request`, `daemon.stop`, ...), a role, a zod input schema, a zod
output schema, and an optional `authorize` hook. Public TypeScript types are
inferred from those schemas, never hand-written a second time. The contract
module imports nothing from `core`, `daemon`, or `drivers` (enforced by
`src/contract/boundary.test.ts`) — core's own domain records
(`DeviceRecord`, `LeaseRecord`, `LeaseGrant`) stay private, and the daemon
maps them onto the contract's shapes in exactly one place
(`src/daemon/dispatcher.ts`'s handlers). If a core type's shape changes
without a matching edit in `src/contract/schemas.ts`, that surfaces as a
compile error or, for a structurally-compatible-but-different shape, a
runtime output-validation failure at the dispatcher boundary — never silent
drift onto the wire.

**One dispatcher (`src/daemon/dispatcher.ts`) serves every transport.**
`Dispatcher#dispatch(operation, input, session)` runs, in order: parse the
input against the operation's schema, reject a session whose role is below
the operation's with `FORBIDDEN`, run the `authorize` hook if the operation
declares one, park on startup readiness (every operation but `status.get`),
call the handler, parse the output. Handlers never see a raw payload or run
a role check themselves. The unix socket server (`DaemonServer`) is framing
plus connection/session lifecycle around this one dispatcher instance; the
HTTP frontend (`src/http/app.ts`) calls the **exact same dispatcher
in-process** — `DaemonServer` exposes it as the one privileged seam an
auxiliary frontend gets — via a bearer-token-to-`DispatchSession` adapter
(`src/http/dispatcher-session.ts`). **HTTP never routes through the unix
socket, or through a second `Dispatcher` instance built with
equivalent-looking options; it is the same object, called directly.** Parity
between the socket and HTTP frontends is a consequence of that sharing, not
of a shared wire format — and every socket-side fix (the download policy in
`config.downloads.policy`, startup-readiness parking, error mapping)
applies to HTTP automatically because there is only one code path to fix.

**Protocol versions are negotiated as `{min, max}` ranges** and honestly:
a range widens only when a compatibility path is actually kept (ADR 0003 §6).
Five changes have moved it since. ADR 0004 removed `lease.heartbeat` and
`mode` from the contract with no shim behind them, taking the wire to
protocol 4; ADR 0005 adds `device.exec`, its `output` push family, and a
`mode` field `status.get` now always carries, again with no compatibility
path kept, taking it to 5; ADR 0008 makes the catalog's `modelRuntimes`
and `modelAliases` required, taking it to 6; ADR 0007 makes every device report its device mode
as a required `mode`, taking it to 7, then lets a lease request choose that
mode with `mode` in place of `full`, taking it to 8. ADR 0010 adds
`component.install` and its `component-progress` push, taking it to 9: a
gateway's `worker.install-component` (ADR 0010 §7)
relays that operation to workers, so a worker without it must be
`incompatible` rather than fail in the middle of a relay. So the range both
sides advertise is `{min: 9, max: 9}`, an older client and a current daemon simply
do not overlap, and `hello` fails with `PROTOCOL_VERSION_UNSUPPORTED` naming
both ranges. The same negotiation runs over a worker's uplink, which is why a
worker older than this shows up in a gateway's views as `incompatible`
rather than as a mystery (see [Gateway and worker
modes](#gateway-and-worker-modes-adr-0005)). `daemon.stop` stays the frozen
exception, accepted at any version the daemon has ever spoken, so the upgrade
path (`simlock daemon stop`, then start the new daemon) exists at all.

**Two roles**, `agent` and `admin`, declared in `src/contract/roles.ts`.
Read-only and lease-lifecycle operations are `agent`; anything that reads or
mutates state outside the caller's own leases (`list.get`, `cleanup.run`,
`nuke.run`, `config.get`, `daemon.stop`, `events.*`, `token.*`) is `admin`.
`doctor.run` is the one operation whose role is a function of its input
rather than a fixed value: `fix: false` is agent-visible (read-only, but it
shells out per device); `fix: true` is admin-only.

**Principal, requester, and owner are three different things** (ADR §4):

- The **principal** is the session identity declared once at `hello` and
  fixed for the connection's lifetime — for HTTP, the bearer token's
  requester id.
- The **requester id** is per-request attribution. `lease.request` accepts
  an optional `requesterId`, defaulting to the principal; core's
  one-lease-per-requester rule stays keyed on it. This is what lets one
  connection (a host process proxying several agents) hold many leases, one
  per requester id, without the socket needing per-agent identity.
- The **owner id** is a field persisted on the lease record, set from the
  session principal at grant time. `lease.renew`/`lease.release`/`lease.list`
  compare `ownerId` to the calling principal (`ownsLease` in
  `src/contract/roles.ts`); `admin` bypasses. A record written before this
  field existed loads with `ownerId` defaulted to `requesterId`.

### Security model: cooperative identity, not a hostile-process boundary

**Socket identity is cooperative, and the docs say so plainly because the
code doesn't hide it either.** Every peer connecting to the unix socket is
the same OS user — file permissions on the socket and on `~/.simlock/*`
already establish that as the real trust boundary. Ownership checks
(`ownsLease`, the principal/requester/owner split above) protect against
*accidents* — releasing a guessed lease id, one agent's request colliding
with another's — not against a hostile local process, which could always
just open the socket itself and claim to be anyone. Real per-connection
identity (a token on every socket connection, not just HTTP's) was
considered and rejected for exactly this reason: it would kill the
zero-setup local experience for the one trust boundary that already exists,
without adding real protection against the thing socket identity cannot
stop anyway (see the ADR's "Alternatives considered").

**Admin authority comes only from a credential presented at `hello`, never
from the socket itself.** Three credentials are accepted, the first two
checked in this order on any client connection:

1. **An operator token**, minted with `simlock token create --role
   operator` and stored (hashed) in `tokens.json`. Long-lived, revocable —
   what a supervisor process uses.
2. **The daemon's per-start admin secret.** Generated fresh on every daemon
   start; only its hash is kept in memory. The plaintext is written to
   `admin.token` under the data directory *after* the socket claim succeeds
   (temp file, then atomic rename — a daemon that loses the start race never
   touches the real file), with owner-only permissions (`0o600`) set at
   creation, and removed on graceful stop. `hello` verifies against the
   in-memory hash, so a credential can be checked before the file has even
   landed on disk.
3. **The worker's own uplink** (ADR 0005 §5). When a daemon joins a fleet it
   dials the gateway named in *its own* `gateway.url` and presents its
   `gateway.token`; the gateway checks that join token, and is then the
   protocol client on the resulting session, which the worker grants the
   `admin` role. What proves that role is the worker's configuration, not
   anything the transport asserts — the same principle as the two above (ADR
   0003 §5) reached from the other end: nothing inbound is trusted, and the
   worker is the party that decided which gateway to obey.

   **Joining a fleet therefore grants that gateway admin over the daemon that
   joined.** That is the real scope of the decision, and it is not a side
   effect: a gateway has to `lease.request`, `lease.release`, `list.get`,
   `config.get`, and `events.subscribe` on its workers, which is exactly what
   an admin CLI does. Point a worker only at a gateway you would hand an
   operator token to.

   The join token is a **bearer credential**, presented in the
   `Authorization` header of the uplink's upgrade request, so anything that
   can read that request can replay it. `gateway.url` should therefore be
   `wss://` — or plain `ws://` only over loopback or inside the operator's
   own tunnel, the same rule the HTTP API already states for itself and for
   the same reason: Simlock terminates no TLS in v1. Only those two schemes
   are accepted; `http://`/`https://` are rejected at load.

A missing or wrong credential fails the handshake with
`ADMIN_AUTHENTICATION_FAILED` before any other request on that connection
runs. The credential is never logged, never returned by any operation,
never read from a config file, and never inferred from the socket path or a
client-declared role. How a caller supplies it, in resolution order: the
`credential` connect option (`simlock/admin`'s `connectSimlockAdmin`),
`--token` (CLI flag), `SIMLOCK_ADMIN_TOKEN` (CLI env var), the local
`admin.token` file (CLI, briefly retried to ride out a daemon still writing
it). **The CLI connects as admin whenever the local `admin.token` file is
readable** — that's what keeps `simlock lease --detach` followed later by
`simlock lease renew <id>` or `simlock release <id>` working across separate
CLI invocations with different pid-derived identities, since all of them
connect as admin and admin bypasses the per-connection ownership check that
would otherwise apply. Renewing someone else's lease is an ownership
question, not a read: a plain agent-role invocation can only renew a lease
its own principal was granted.
When none of the CLI's three sources resolves (a different OS user, or the
file genuinely missing), the CLI falls back to an agent-role session with a
one-line stderr notice, and `simlock lease`'s output JSON includes the
connection's resolved `role` so a caller can tell which one it got.

**`doctor.run` without `fix` is agent-visible and read-only, but it still
shells out per device** (`simctl`/`adb`) to compare registry state against
driver reality — worth knowing before calling it from a tight loop or a
context where that per-device process-spawn cost is unwelcome. `fix: true`
requires the admin role because it can quarantine or destroy devices.

See [CLIENT.md](../CLIENT.md) for how `simlock/client`/`simlock/admin` expose
`credential` and role at connect time, [CLI.md](../CLI.md#admin-credential-resolution)
for the CLI's own walkthrough of the same resolution order, and
[HTTP-API.md](../HTTP-API.md#authentication) for how HTTP's bearer-token roles
map onto `agent`/`admin`.

## Gateway and worker modes (ADR 0005)

`config.mode` selects which of two shapes a daemon runs as, and one daemon
runs exactly one of them:

- **`worker`** (the default) is everything described above and below in this
  document: drivers, device roots, registry, capacity, reaper, health
  monitor, leases. Every simlock daemon before ADR 0005 is a worker.
- **`gateway`** owns no devices at all. It starts no drivers, validates no
  device roots, and runs no reaper, health monitor, or capacity strategy.
  What it owns is *demand*: one fleet-wide queue of lease requests, a live
  view of every worker connected to it, and the routing decision that puts
  the two together.

To a client the difference is invisible. A gateway implements the same typed
contract (ADR 0003) towards its own clients that a worker does, so the CLI,
MCP, the HTTP frontend, `simlock/client`, and the web console (#88) work
against one with no frontend change — `mode` in `status.get`'s daemon block
is the only field that tells them apart.

```
                    agents (CLI · MCP · simlock/client)
                    web console (#88) · agent-device
                                  │
                       one URL / one unix socket
                                  │
                                  ▼
                    ┌──────────────────────────────┐
                    │ simlock daemon, mode gateway │
                    │  worker views · fleet queue  │
                    │  routing policy · dispatch   │
                    │  lease index · event bus     │
                    │        (no drivers)          │
                    └───▲───────────────────────▲──┘
                        │                       │   the gateway is the
              uplink    │             uplink    │   protocol client here
       (each worker dials out: WebSocket + join token)
                        │                       │
        ┌───────────────┴──────┐   ┌────────────┴─────────┐
   ┌───▶│ simlock daemon,      │   │ simlock daemon,      │◀───┐
   │    │ mode worker (Mac A)  │   │ mode worker (Mac B)  │    │
   │    │ core · drivers ·     │   │ core · drivers ·     │    │
   │    │ registry · capacity  │   │ registry · capacity  │    │
   │    └──────────┬───────────┘   └──────────┬───────────┘    │
   │               │ simctl / adb             │ simctl / adb   │
   │               ▼                          ▼                │
   │        iOS / Android devices      iOS / Android devices   │
   │                                                           │
 local agents on Mac A,                  local agents on Mac B
 over that daemon's own unix socket — unchanged, and sharing its capacity
```

Only the gateway listens for inbound connections. Workers **dial out**, so a
machine behind NAT, a laptop, or a CI runner joins a fleet with a URL and a
token and needs no inbound port, no tunnel, and no address a client ever
learns. A machine that should both front a fleet and own devices runs **two
daemons** with distinct `SIMLOCK_HOME`s — a gateway and a worker, the worker
joining over localhost. There is no hybrid mode: every gateway code path
would need a "local" special case, and the gateway would hold device state.

### The uplink

A worker with `gateway.url` and `gateway.token` set opens one outbound
WebSocket to `<gateway.url>/v1/uplink` on start, and again after any
disconnect on exponential backoff, presenting its join token (role `worker`)
and its instance id. The gateway verifies the token against its own token
store. A missing or unrecognized token is `401`; a **valid token of the wrong
role is `403`** (ADR 0005 §4) — two different facts, answered the way the
rest of the API already answers them. Either way nothing enters the worker
registry and the gateway emits `worker.rejected` (see [EVENTS.md](EVENTS.md)).

Over that one socket **the gateway is the protocol client**. It sends `hello`
and issues ordinary contract operations to the worker's own dispatcher,
exactly as a local admin CLI would over the unix socket — there is no second
API and no second vocabulary between gateway and worker, so every operation
added to the contract is available over the uplink for free. The worker
grants that session the `admin` role because *it* opened the connection, to
the gateway named in its own config; the trust runs from the worker's
configuration, never from the transport (ADR 0003 §5).

The uplink is also the reachability signal, so nothing polls for liveness: a
worker whose uplink is open is `connected`, one whose uplink is closed is
`disconnected` and keeps its last-known view (greyed, never dispatched to)
until an operator removes it or `gateway.disconnectedRetentionMs` (24 hours)
elapses. That clock is **held** while the gateway still knows of
gateway-issued leases on the worker, because forgetting a worker that is
holding someone's device is how a lease becomes unroutable — and the hold
ends when the last of those leases passes its deadline, since a lease nobody
can renew is one the worker has already expired on its own clock. The hold is
therefore bounded by a TTL rather than open-ended: a worker gone longer than
every lease it held has nothing left to protect.

The uplink is a port on both sides — `UplinkListenerFactory` on the gateway,
`UplinkConnector` on the worker — with a WebSocket adapter (`ws`) as the one
real implementation, so tests script a whole fleet in memory against a
manually-advanced `Clock`, exactly as the core's tests script drivers.

### The worker view

A **worker view** is what the gateway currently knows about one worker: its
id, `label`, daemon health and version, negotiated protocol range (only when
`incompatible`), capacity per platform, queue depth, leases, devices,
catalog, host facts, installs in progress, effective download policy and
timeout, `lease.maxTtlMs`, and drain state. On connect the gateway calls
`status.get`, `list.get`, `catalog.get`, `config.get`, and `events.subscribe`
on the worker and builds the view from the answers. It refreshes status and
list on every worker event that changes capacity or leases, and on
`component.install-started`, `component.installed` and
`component.install-failed` (ADR 0010 §7); after `component.installed` it
re-reads catalog and config too. A slow periodic tick refreshes all four
reads, catalog and config included, so a runtime installed on a worker by
other means still reaches its view without a restart of either side.

The **host facts** are the `host` block of the worker's `status.get`
(ADR 0008 §5-§8): operating system, version, architecture from the host
port, read once at the worker's start, and tool versions from each driver's
`toolVersions()`, joined in `core/host-facts.ts`. The worker serves them from
memory, so `status.get` stays a liveness probe that never starts a process;
a stale value starts a background re-read after 60 s. A driver leaves out a
tool that is not installed and rejects a read that fails; the core then keeps
that driver's last answer, and gives up on a read after 30 s. The contract's
`fitHostFacts` cuts what the daemon serves to the schema's bounds. They come
over on every status refresh. An `incompatible` worker is asked nothing, so its view
carries none. A gateway's own `status.get` reports the gateway's machine with
no tools.

From `config.get` the gateway keeps two fields. The effective
`downloads.policy`, for display only: routing counts installed runtimes and
never reads it (ADR 0009 §3). And `lease.maxTtlMs`, compared against the gateway's own to warn when a
worker's cap is lower. Config is daemon input, read at start, so these change
only across a worker restart; re-reading them on the tick costs one call.
`config.get` is an admin operation, which the uplink session is.

The view is **rebuilt, never persisted**. A gateway restart loses nothing it
cannot ask for again, and a worker stays the authority on its own state. Two
consequences are worth stating plainly:

- The worker **id is the worker's existing instance identity**
  (`${SIMLOCK_HOME}/instance.json`) — stable across restarts, unique by
  construction, opaque to clients. `label` (`gateway.label`) is display-only
  and need not be unique; nothing routes on it.
- A view can be **stale by a moment**, and the design assumes it. Dispatch
  treats a `NO_CAPACITY` answer from a worker as a stale view rather than as
  a failure (below), which is what lets routing be an ordinary pure function
  over the last known numbers instead of a distributed reservation protocol.

`worker.list` (admin) returns the views; `worker.drain`, `worker.undrain`,
and `worker.remove` are the operator's edits to them. A **drained** worker
keeps its existing leases and receives no new dispatches — the tool for
taking a machine down without killing anyone's device.

A worker answers these operations as a **fleet of one** (ADR 0012).
`worker.list` returns one view, the worker itself: its instance id, its
`gateway.label`, `connected`, never drained, `lastSeenAt` the time of the
call. The reported fields come from its own `status.get`, `list.get`,
`catalog.get` and `config.get`, turned into view fields by
`workerViewFields` in `src/contract/worker-view.ts` — the same pure function
`WorkerLink` builds a gateway's views with, so the two cannot disagree about
a field. The catalog is the one read the worker keeps: `catalog.get` runs
each driver's catalog read (`simctl list` on iOS), and the console polls
`GET /v1/workers` every second, so the dispatcher re-reads it only once
`WORKER_VIEW_REFRESH_INTERVAL_MS` (the gateway's own refresh tick) has
passed, or after one of `WORKER_VIEW_CATALOG_EVENTS`. Both constants live
in `src/contract/worker-view.ts`, and `WorkerLink` reads the same two, so a
host's view of itself and a gateway's view of it re-read the catalog on the
same rhythm. The dispatcher's subscriptions end when `DaemonServer` stops. `worker.drain`, `worker.undrain`, `worker.remove` and
`worker.install-component` answer `UNSUPPORTED_IN_WORKER_MODE` (`501`, exit
`2`), the mirror of `UNSUPPORTED_IN_GATEWAY_MODE`. The `/v1/workers*` routes
are registered in both modes.

Drain is the one piece of worker state the gateway *decides* rather than
observes, and it is why the **worker registry** and the worker *view* are two
different things. The view is the observation: rebuilt on every connect,
never persisted. The registry is the gateway's own record of which workers it
knows and which of them an operator has drained (ADR 0005, "Worker registry
(gateway side)"), and it **is** persisted — a small JSON file under the
gateway's `SIMLOCK_HOME`, written with owner-only permissions like everything
else simlock keeps there.

A drain therefore survives both a worker reconnect and a gateway restart.
Both halves matter: a machine taken out of rotation for maintenance must not
rejoin it because its own daemon restarted, and must not rejoin because the
*gateway* restarted either — an operator who drained a worker and walked away
has no reason to expect a process they never touched to undo it. `undrain` is
the only thing that ends a drain.

### The fleet queue and dispatch

A lease request arriving at a gateway enters **one gateway-side FIFO queue**,
where `timeoutMs` (`QUEUE_TIMEOUT`), `noWait` (`NO_CAPACITY`),
`lease.cancel`, and the `queued` progress state with its `queuePosition` all
mean exactly what they mean on a worker.

**Dispatch** runs whenever the queue or any worker view changes. For each
queued request, oldest first, the routing policy picks a worker and the
gateway sends it `lease.request` with **`noWait: true`**:

- the request becomes `dispatched` on either of two signals from that
  worker: the grant itself, or the first `progress` push for it
  (`provisioning`, `booting`, `reclaiming`) — device work has started, so the
  request belongs to that worker and dispatch stops considering it;
- an **immediate `NO_CAPACITY`** is the only answer that leaves it queued: it
  means the view was stale, so the gateway refreshes that worker's view and
  the request waits, no worse off than before. The gateway remembers the
  refusal for that request against a key built from the worker's view
  (capacity, queue depth, health, devices, lease ids; not timestamps), and
  does not pick that worker for that request again while the key is
  unchanged: another worker is tried instead, and the refusing worker is
  asked once per change of its state, not on every refresh (ADR 0009 §5). A
  `noWait` request refused this way gets one more walk without that worker,
  and fails with `NO_CAPACITY` if no worker is picked in it. A failure
  *after* work has begun is the request's own terminal failure, not a return
  to the queue;
- a worker's own **cannot-serve refusal** (`UNKNOWN_MODEL`,
  `RUNTIME_MISSING`, `NO_DRIVER`) before any progress push is retried on
  another worker: the gateway keeps that worker out of every view the walk
  uses for that request (the table's included, for good, not until its view
  changes), re-reads its catalog, and returns the request to the walk. The
  queue deadline is not reset. When the table over the remaining views no
  longer says route or wait, the request is rejected with the last such
  refusal, the worker's own code and message. The worker already emitted its
  own `lease.rejected`, so the gateway emits none, unless the request had
  entered the gateway queue: its `lease.queued` needs a terminal fact, so the
  gateway emits `lease.rejected` with reason `unresolvable-spec`. After a progress push, and for any other
  code, a failure is final (ADR 0009 §5);
- a request a busy fleet cannot take yet is **passed over, not blocked on**,
  so an Android request behind an iOS one proceeds the moment Android
  capacity frees. A request **no worker can serve at all** is not passed
  over: the same walk rejects it first (see "A request that cannot be
  served" under Routing).

`noWait` is what keeps the two queues from becoming one problem. Because a
dispatch either takes immediately or refuses, **no gateway request ever sits
in a worker's queue**: it can still be granted by whichever worker frees
first, and local agents on the worker machine keep using their own daemon's
queue without ever competing with the fleet for a queue slot. The two contend
for *capacity* only, and the worker's own capacity accounting is the single
arbiter of that — the same accounting that already arbitrates between two
local agents.

### Routing

Routing is a pure function over the current worker views, in one module with
one entry point selected by `gateway.routing`, the same shape as
`CapacityStrategy`. Nothing else in the gateway knows how a worker is chosen.

A policy is an ordered list of **stages** (ADR 0009 §1), each a pure function
over worker views. A **filter** drops workers. A **rank** scores them: when
its best score is zero or less it abstains and changes nothing; otherwise it
decides and keeps its best scorers. A rank may **settle**, ending the walk
when it decides. The pick is the first remaining worker in ascending worker
id, provided at least one rank decided. The deciding stage — the last rank
that removed a worker, or the last that decided when none removed any — is
reported on `request.dispatched`. `gateway.routing` names a whole list; the
lists are code, and no config key lists or orders stages.

The v1 policy (`warm-then-free`) is four stages:

1. `takes-requests` (filter): drop workers that are disconnected,
   incompatible, drained, or whose capacity or catalog has not been read
   since they connected;
2. `can-serve` (filter): drop workers whose catalog cannot serve the request
   (ADR 0009 §3, `routing/request-match.ts`). The model is the first entry of
   the worker's `models` whose name or `modelAliases` entry equals the
   requested name, ignoring letter case. A named runtime must be in that
   model's `modelRuntimes`; with none named the list must be non-empty. Only
   installed runtimes count, so a download never makes a worker able to
   serve;
3. `warm-hit` (rank, settles): prefer a worker with an unleased `ready` device
   matching the request, compared against the worker's own name for the
   model — a **warm hit**, and a sub-second grant;
4. `free-capacity` (rank): otherwise the worker with the **most free running
   capacity** for that platform.

The same matcher gives the name the gateway forwards: the worker is sent its
own name for the model, so it resolves exactly what routing matched, and
`allowDownload` is always forwarded as `false`. `lease.requested` keeps the
name the client sent.

#### A request that cannot be served

Before the stages, the dispatch walk asks `assess(request, views)`
(`routing/serviceability.ts`, ADR 0009 §4), over every view, busy or not. It
is the one place the fast-fail table lives, and it runs for each queued
request and, last, the request that has just arrived and is not queued yet. An
arriving request on rows 1 to 5 is rejected without entering the queue (no
`lease.queued`, no `queued` progress), and a drain or a lost uplink re-runs the
walk, which rejects a waiting request that has moved onto those rows. In
order: no worker takes requests, `NO_CAPACITY` (reason `no-worker`); no known
worker has the platform, `NO_DRIVER`; none lists the model, `UNKNOWN_MODEL`;
none has the runtime or pairs it with the model, `RUNTIME_MISSING` with
`downloadable: false` and `osVersion: "default"` for an unnamed runtime (the
last three with reason `unresolvable-spec`); a known worker can serve it but
none that takes requests can, `NO_CAPACITY` (`no-worker`); otherwise route or
wait. A worker *takes requests* when it passes `takes-requests`; the gateway
*knows* a worker when its view holds a catalog and it is not
`incompatible`. The view's `catalogReadAt` is set by a refresh that carries a
catalog and cleared when the worker connects, so a reconnecting worker is
known from its last catalog but takes requests only once the new one arrives,
and a first-time worker with no catalog yet is neither (its catalog is empty,
so it says nothing about any platform or model). `WorkerLink` coalesces refreshes and keeps
`includeCatalog` on a queued follow-up, so a catalog refresh that arrives
during another refresh is still read.

There is no other placement rule in v1: no requester affinity, no label
selectors, no per-worker platform exclusions. Each of those is a future
routing policy behind `gateway.routing`, not a change to the request shape —
which is why a lease request has the same shape against a worker and against
a gateway.

### Leases through the gateway

TTL-first leases (ADR 0004) are what let the gateway hold almost no lease
state at all. `lease.renew`, `lease.release`, and single-lease reads are
**forwarded** to the owning worker, and the `expiresAt` a client sees is the
worker's own. There is nothing to emulate and no timer to run: a client that
stops renewing loses its lease on the worker's clock, gateway or no gateway.

- **The lease id names its worker.** A gateway lease id is the owning
  worker's id, then a `.`, then the worker's own lease id — so renew,
  release, and reads route by splitting on the **first** `.` rather than by
  consulting state a restart could lose. A worker id is its instance
  identity, a UUID, so a real one reads
  `3f81a2c4-9b7d-4e21-8a55-1c0e6f2d7b93.lse_9f2c`; every example in these
  docs abbreviates it to its first segment for legibility. Clients treat the
  whole thing as opaque, exactly as they already treat `lse_9f2c`.
- **The lease object gains `worker: { id, label }`** (additive) so a client
  and the console can say *where* the device lives. A worker's network
  address is never on it: clients reach devices through the gateway.
- **One lease per requester is fleet-wide.** A requester already holding a
  gateway-issued lease on any worker gets `REQUESTER_ALREADY_LEASED` from the
  gateway, naming the existing lease. The gateway enforces this from its own
  index of the leases *it* issued, rebuilt from each worker's `lease.list` on
  uplink connect. It picks its own out of that list by the requester prefix
  it stamps on every lease it forwards — `gw:<its own instance id>:` — which
  works precisely because the gateway's instance id is stable across
  restarts: the index can be rebuilt from a worker's leases alone, with
  nothing persisted on the gateway and no ambiguity about which of them are
  its own, another gateway's, or the worker's local ones. `release --all` and
  the disconnected-retention hold both use that same filter, which is what
  keeps them from ever touching a lease this gateway did not issue.
- **The requester id the gateway forwards is namespaced**:
  `gw:<gateway instance id>:<requester>`. A local agent on the worker machine
  and a remote agent behind the gateway therefore can never collide on the
  worker's own one-lease rule, and every lease on the worker is attributable
  to the fleet it came from. The namespace is worker-side bookkeeping: the
  gateway reports the leases it issued under the client's own requester id.
- **The gateway keeps no per-connection lease state** and releases nothing
  when a client connection closes, exactly as a worker (ADR 0004 §3).
- **Pushes are relayed, not re-invented.** Progress for a dispatched request,
  and the lease-scoped `lease-lost` / `device-unhealthy` / `device-recovered`
  facts the worker's event stream carries, are re-pushed to whichever gateway
  connection owns the request or lease — the same owner routing rule a worker
  applies (ADR 0003 §8).

### Reaching a device: `device.exec`

`driver.passthrough` resolves a root-scoped command string for the *caller*
to spawn, which only works on the worker's own machine. `device.exec` (role
`agent`) is the operation that works everywhere:
`{ leaseId, tool: "simctl" | "adb", args, stdin?, requesterId? }`.

The **worker** resolves the command through the same driver passthrough logic
— same root scoping, same refusal list for verbs that would change a device's
lifecycle behind the registry's back (`PASSTHROUGH_REFUSED`, or
`UNKNOWN_PASSTHROUGH_TOOL` for a `tool` it does not wrap) — and runs it
through its `ProcessRunner`. Output streams back as request-scoped `output`
pushes (`stream: "stdout" | "stderr"` plus a chunk, keyed by the frame id
exactly like `progress`), and the operation resolves with `{ exitCode }`. The
refusal list gains one entry this operation needs and the local passthrough
does not: a bare `adb shell` with no command is refused
(`PASSTHROUGH_REFUSED`, "needs a terminal") rather than accepted into a
session nobody can type into, which would otherwise sit there until the
timeout killed it.

**Ownership is proven on both hops.** A non-admin session is gated the
ordinary way — its principal against the lease's `ownerId` (ADR 0003 §4),
exactly as `lease.renew` and `lease.release` are. `requesterId` (optional,
defaulting to the principal) exists for the one session that would otherwise
bypass that check: the gateway's admin session on a worker. Unlike renew and
release, **admin does not bypass here** — the worker compares the supplied
`requesterId` to the lease's own `requesterId` and answers `FORBIDDEN` on a
mismatch. Without that, "the gateway checked its own lease index" would be
the only thing standing between one fleet agent and another agent's device.
Two independent checks, one per hop: the gateway checks its lease index and
forwards the namespaced requester, and the worker checks that requester
against the lease in front of it.

The **gateway proxies** the call to the owning worker over the uplink and
relays those pushes to the calling connection unchanged. It parses nothing
about the command. Because output is streamed rather than buffered there is
no size cap; what bounds a command is a timeout on each hop. `exec.timeoutMs`
on the worker (ten minutes) is the authoritative one, because that is the
side owning the process and able to kill it; `gateway.execTimeoutMs` (eleven
minutes) is a backstop for the case where the worker never answers at all —
deliberately the longer of the two, so an ordinary timeout surfaces as the
worker's own `EXEC_TIMEOUT` instead of racing the gateway's (ADR 0005 §19e).

Two deliberate limits: `stdin` is a single string sent with the request, not
an incremental channel, and there is no pseudo-terminal — line-oriented
commands work, full-screen ones do not. And `device.exec` runs against the
**worker's** filesystem, so an artifact a command names (`simctl install
<path>`, `adb install <apk>`) has to get there out of band. The seam for a
later `device.upload` — chunks streamed as request-scoped pushes into a
per-lease scratch directory deleted on release — is left open by design, not
built. See [known-pitfalls.md](known-pitfalls.md).

This is also what closes the gap that left `dataPlane` reserved: a remote
HTTP agent gets the same ability against a lone worker, with no gateway
involved at all.

### Aggregated reads

`status.get` on a gateway returns the same shape a worker returns — capacity
summed across connected workers, every gateway-issued and local lease, every
device, the gateway queue's depth — plus an additive `workers` array of
views, and `workerId` on every device and lease in the aggregate.
`catalog.get` is the union of the worker catalogs, each model and runtime
annotated with the workers that have it. A model's `modelRuntimes` is the
union of what each connected worker pairs it with, never the cross product
of fleet models and fleet runtimes: one worker with the model and another
with the runtime is not a leasable pair. `modelAliases` is the union per
model, deduplicated ignoring case, and `images` the union by runtime, tag,
and ABI, absent when no worker reports the field. `customModels` lists a
model when any worker that lists it marks it custom; a name a worker marks
but does not list is dropped. Each worker's lists are
within the contract's bounds but their union may not be, so the gateway
cuts the sorted union to those bounds rather than answer with a catalog its
own clients would refuse. Routing reads `models`, `runtimes`,
`modelRuntimes`, `modelAliases`, and, for a request naming an image tag,
`images`.

Within a worker, each driver decides which installed runtimes pair with a
model in one function that `listCatalog` and `resolveSpec` both call
(ADR 0008 §3): on iOS, available runtimes that list the device type in
`supportedDeviceTypes` and fall in its version range; on Android, every
installed API level, foreign-ABI images included. So a listed pair always
resolves. The same holds for names: the Android driver's
`DeviceProfileRegistry` owns the only matcher (first profile, in source
order, any of whose names equals the request ignoring case), and the
catalog's `modelAliases` are a profile's other names that the matcher sends
back to that profile. A listed model is in `customModels` when the profile
the matcher sends its name to is a `devices.xml` one (parsed by Simlock, or
listed by `avdmanager` with `OEM : User`), so the mark and the resolution
cannot disagree. The iOS driver matches a device type's name
only. `DriverCatalog.listCatalog` leaves out and logs a driver whose catalog
rejects when no platform is named, and fails with that driver's error when
its platform is named.

Worker business events are republished on the gateway's bus with `workerId`
added to the payload and land in the gateway's own ring buffer and event
file, so `simlock events --follow` against a gateway shows the whole fleet and
`--since` reaches back across a gateway restart. The gateway also
emits its own facts — `worker.connected`, `worker.disconnected`,
`worker.rejected`, `worker.removed`, `worker.drain-started`,
`worker.drain-ended`, and `request.dispatched`; see [EVENTS.md](EVENTS.md).

### Failure behaviour

- **Uplink down.** No new dispatches to that worker. A renew or release for a
  lease on it fails with `WORKER_UNREACHABLE` (`kind: "transport"`). The
  worker's own TTL expires the lease and reclaims the device on its own
  clock, and the gateway relays `lease-lost` once the uplink returns and it
  sees the worker's `lease.expired` fact. **The gateway never guesses a lease
  is gone before the worker says so** — it cannot tell a dead worker from an
  unreachable one, and only one of those has released anything.
- **Dispatched, then the uplink drops.** The request's client sees
  `WORKER_UNREACHABLE`. If the worker actually granted it, that lease exists
  on the worker and expires there on its TTL. A retry hits the fleet-wide
  one-lease rule only once the uplink is back and the index is rebuilt —
  so the client re-requests, and a `409 REQUESTER_ALREADY_LEASED` names the
  lease to read back.
- **Gateway restart.** In-flight requests are lost: a gateway keeps its lease
  requests in memory only, while a worker stores its own in `state.json` (#72).
  Leases survive on their workers; workers reconnect on their backoff and the
  gateway rebuilds every view and its lease index from them — picking its own
  leases out of each `lease.list` by the `gw:<its own instance id>:`
  requester prefix, which is why an instance id stable across restarts is
  what makes a stateless rebuild possible at all. The worker registry, which
  workers it knows and which are drained, comes back off disk rather than
  being re-derived. Clients keep their leases and resume
  renewing once the gateway answers again; a lease whose deadline passes
  while the gateway is down expires on the worker, like any other unrenewed
  lease.
- **Version skew.** `hello` over the uplink negotiates the protocol range
  exactly as over the socket (ADR 0003 §6). ADR 0005 moves the wire to
  protocol `{min: 5, max: 5}` with no compatibility shim — `device.exec` and
  its `output` push family are new frames, and the honesty rule says a range
  widens only where a compatibility path is actually kept — so **every worker
  older than ADR 0005 is `incompatible` by range**, by construction rather
  than by accident. ADR 0008 moves it again, to `{min: 6, max: 6}`, because
  the catalog's `modelRuntimes` and `modelAliases` are required, and ADR 0007 to
  `{min: 7, max: 7}`, because a device's `mode` is required, then to
  `{min: 8, max: 8}`, because a lease request chooses it, and ADR 0010 to
  `{min: 9, max: 9}`, because the gateway is to relay `component.install` to workers; a
  worker on an older version is `incompatible` the same way. That is the ordinary upgrade path, not a failure mode:
  upgrade the worker. An incompatible worker is marked `incompatible` in its
  view with both ranges shown and is never dispatched to, and it is not
  hidden either — that is the machine an operator has to go and upgrade, and
  it keeps serving its own local clients on its own protocol meanwhile.

### Why this is safe

**The gateway never touches a device.** Every invariant in
[agent-rules/safety.md](agent-rules/safety.md) keeps holding by construction
rather than through a second implementation of it: registry-only destruction,
never touching a leased device, reconcile-before-trusting, and
ownership-proven-not-inferred are all enforced where the registry and the
drivers are, on the worker. The gateway forwards `allowDownload` and the
worker clamps it through its own `downloads.policy`, so "no implicit multi-GB
downloads" is decided by the machine that would do the downloading.

That is also why the machine-wide operations stay per-worker: `nuke.run`,
`cleanup.run`, `doctor.run`, and `driver.passthrough` answer
`UNSUPPORTED_IN_GATEWAY_MODE` on a gateway in v1. Fanning a destructive
command out to every machine in a fleet from one endpoint is not something v1
should offer, and a passthrough command string the client cannot run is worse
than an error. `config.get` on a gateway returns the gateway's own config.

### Boundaries

The gateway is a second implementation of the contract's **handlers** (ADR
0003 §2), not a second contract: `src/gateway/` provides a `Dispatcher` whose
handlers read worker views and forward over uplinks instead of calling
`core`. That is the whole reason every existing frontend works against it
unchanged.

`src/gateway/` **imports nothing from `drivers`** — it has no concept of a
UDID, an AVD, a snapshot, or an adb port — and from `core` only the
platform-agnostic queue and bus modules it reuses, never the registry,
capacity, or lifecycle modules. A boundary test in the same shape as
`src/contract/boundary.test.ts` enforces it. The rule is not stylistic: a
gateway that could reach a registry module is a gateway that could grow a
device-state opinion, and the safety argument above rests on it having none.

## Core vs. drivers

The core is platform-agnostic and written once: lease table, fair wait queue,
managed-device registry, capacity accounting behind a pluggable strategy
(the default derives limits from the machine and treats RAM as the binding
constraint for Android emulators), the device state machine, the
cleanup reaper, the leased-device health monitor, the event bus, and
warm-pool *policy*.

Platform mechanisms live behind a narrow driver interface:

```
resolveSpec(request) -> concrete device spec | "runtime missing"
provision(spec)      -> device
makeReady(device)    -> ready device          // boot + readiness probe
reclaim(device)      -> ready | shutdown      // fresh-state strategy lives here
shutdown(device)
destroy(device)
estimate(op)         -> ETA for progress events
listManaged()        -> device/process reality inside this driver's owned root, for doctor
```

The litmus test for the boundary: adding a third driver (e.g. physical
devices) must require **no core changes**. If it does, the interface leaked.

A request may name an image tag (#214). The core carries `imageTag` from
the request to `resolveSpec` and onto the spec without reading it: `sameSpec`
compares it, so a tagged device and an untagged one never share a pool, and
`LeaseAcquisitionCoordinator` refuses a resolved spec whose tag is not the
request's. Only the Android driver knows what a tag is. Its one image picker
(`#matchingImage`) serves resolving and creating alike, picks among the
installed images of the tag (host ABI first), and a missing tag is a
`RuntimeMissingError` naming no component, so a tagged request never
downloads. A driver without image types (iOS) refuses the option itself with
`UnsupportedRequestOptionError` (`BAD_REQUEST`); the core keeps no list of
which platforms take it. On a gateway, `matchRequest` counts a worker's
runtime for a tagged request only when the catalog's `images` lists the tag
for it, and `warm-hit` compares the device's tag.

### Prerequisite checks

Simlock installs none of the platform tools it drives (Xcode; the Android SDK's
`cmdline-tools`, `emulator`, `platform-tools`; a JDK). Each driver module also
exports a `PrerequisiteCheck` (`src/drivers/ios/prerequisites.ts`,
`src/drivers/android/prerequisites.ts`) that says which of them are missing and
how to install each. The checks are deliberately not methods on the `Driver`:
they matter most when the driver could not be built, because something it needs
is missing. The composition root builds them beside discovery (iOS only on
macOS, Android everywhere; a `SIMLOCK_DRIVERS_MODULE` supplies its own through
an optional `prerequisiteChecks` export) and hands them to `Doctor`, which runs
them on every `doctor.run` and never during startup convergence. The core
carries `prerequisite`, `message` and `remedy` unread; the only text it adds is
the restart sentence for a platform that is not running, since discovery runs
once per daemon. A check is read-only, bounds every process it starts, and
rejects rather than guessing when it cannot tell. The Android check locates
each tool through the same functions discovery uses
(`src/drivers/android/sdk-paths.ts`), so the two cannot disagree about where a
tool is.

### Device roots

Each driver owns a directory that Simlock created and marked, and scopes every
platform command to it: iOS through `xcrun simctl --set`, Android through
`ANDROID_AVD_HOME` plus a private adb server on a port the shared server does
not scan. Devices inside a root are invisible to Xcode, Android Studio, and a
plain `simctl` / `adb`; conversely Simlock cannot address anything outside it.
There is one deliberate exception: a device stranded in the pre-root location
by the migration, which `doctor` reports and `--fix` destroys through the old
unscoped path — permitted because a registry record names it, which is what
registry-only destruction asks for.

Containment cuts both ways, so the scoping has to be handed back to a lease
holder that needs to drive its device. That happens two ways, and both go
through the same driver code (`Driver.passthrough()`, which owns the scoping
flags *and* the list of verbs it will not proxy -- `simctl delete`,
`adb kill-server`, anything that would change a device's lifecycle behind the
registry's back). `driver.passthrough` *resolves* the scoped command and hands
it back for the caller to run, which is what `simlock simctl` / `simlock adb`
do locally: the daemon is the process that knows the root, the CLI is the one
with a terminal, so an interactive `adb shell` keeps its tty and its exit code.
`device.exec` (ADR 0005) *runs* the same resolved command on the daemon's own
machine through the `ProcessRunner` port and streams stdout/stderr back as
request-scoped pushes, resolving with the exit code -- for a caller who is not
on that machine and for whom a command line naming a device set would be
useless. One resolution, one refusal list, two ways to reach it; the split is
who spawns the process, never what is allowed.

The one thing the resolution is told about its caller is whether there is a
terminal behind it, because that is the one thing that genuinely differs: an
exec'd command runs on pipes, so a driver may refuse there what it allows a
local invocation with a tty (a bare `adb shell`). The fact travels to the
driver rather than being decided in the daemon, for the same reason the rest of
the list lives there -- knowing which of adb's commands needs a terminal is
Android's business, not the core's.

Ownership is proven when the driver starts, and re-proven
(`Driver.revalidateRoot()`) immediately before `doctor --purge-orphans`
destroys anything in a root: reporting can live with a proof taken days ago,
destroying cannot (see [known-pitfalls.md](known-pitfalls.md)).

This is what lets `listManaged()` answer from membership rather than from a
name prefix — the difference between *proving* ownership and *guessing* it.
The registry is unaffected in role: the root is the authoritative device
**inventory**, the registry is the authoritative device **state** (which of
seven states, whose lease, which timers, how many recovery attempts left).
Reconcile compares the two, and "in the root but not in the registry" now means
orphan rather than "possibly the user's, don't touch".

The root path is the only new thing the core hands a driver, and it hands it as
an opaque per-driver config entry (`drivers.<platform>.*`) that the core never
interprets — so a third driver contributes its own root and its own scoping
mechanism without a core edit, and the litmus test above still holds.

See [ADR 0001](adr/0001-simlock-owned-device-roots.md) for the decision and the
platform behaviour it was verified against.

## Running capacity

Managed-device limits govern provisioning, while running limits govern any
operation that starts a device. Where those limits come from is a
`CapacityStrategy`, selected by config: `resource` derives them from the
machine and adds a RAM budget, `fixed` pins them to a configured number.
Each strategy lives behind one entry point in `core/capacity/strategies/`
and is registered in one map, so adding a policy touches neither the
coordinator nor its callers. The core accounts `ready`, `leased`,
`reclaiming`, and `quarantined` devices as running. A serialized,
platform-agnostic reservation covers provisioning and boots from `shutdown`
until the registry commits the resulting running or non-running state. Global
and platform limits are checked atomically; no driver-specific runtime
details participate in this decision.

Every capacity device carries a mode (`slim` or `full`), and
`core/capacity/devices.ts` is the one place a registry record or a spec
becomes one (ADR 0007 §4, §6, §8). A slim device uses full RAM until its
slim pass runs, so a device about to be created, and one still
`provisioning`, counts as `full`; every other device counts by the mode its
record reports. The `resource` strategy sizes each device by platform and
mode (a slim size left unset falls back to the full one) and uses one sum
and one limit for `canProvision`, `canBoot` and `status.get`'s
`capacity.ramBudget`. `canBoot` refuses with `ram-budget` when the boot's
extra size (full minus the device's own size) does not fit. The
coordinator's boot reservation, taken by the planner for a shut-down device
and by the warm pool for a reclaimed device it boots back to warm, counts
that device as `full` in every decision until released; status leaves every
reservation out. A boot refused for RAM evicts nothing and waits. Running
slots ignore mode. A recovery reboot is not checked and boots full while the
record keeps its mode (KNOWN-PITFALLS). A restart with larger sizes can
leave the budget over its limit; the strategy then refuses every
new device and every boot that adds RAM, and the core stops or reclaims nothing for
it. `fixed` ignores mode, never refuses a boot, and reports no budget.

At startup, `StartupConverger` restores the persisted TTL timer of **every**
lease it finds, and re-arms retry timers for devices still `quarantined` (see
below) from their persisted next-retry deadline. A lease survives a daemon
restart because a lease's liveness was never the daemon connection to begin
with (ADR 0004). The *holder* does not survive it in the same way: the typed
client never reconnects (ADR 0003 §10), so a running `simlock lease` exits `1`
when the old daemon goes away and something has to renew the lease from a new
invocation before its deadline. What the restart no longer does is decide the
question for you by releasing the lease outright. There is no orphan sweep at
startup — nothing about a restart proves a holder is dead, so nothing is
released on the strength of it. A lease whose deadline already passed while no
daemon was running expires as soon as one is, through the ordinary expiry path.
`StartupConverger` then recovers unleased interrupted reclaims through the
warm-pool recovery port — a backgrounded reclaim marks its device with a
`reclaim` operation claim for exactly this reason, so this step can tell it
apart from one truly orphaned by a *previous* crash (unclaimed, since claims
never survive a restart) rather than cutting it short — and finally
deterministically shuts down excess unleased, unclaimed `ready` registry
devices through `CleanupActionExecutor`. Leased devices are never touched by
any of this, so a lowered limit may remain visibly over-limit until leases
expire or are released.

The capacity sweep's view of what's `ready` is only ever a snapshot, and a
background reclaim in flight makes it more so: `reclaiming` already counts
toward the running total (see above), but a device mid-reclaim cannot be a
shutdown *candidate* until it settles. The sweep does not wait for that or
re-run afterward — it tolerates the transient view, because a completed
reclaim (`WarmPoolCoordinator#reclaim`) makes its own capacity-aware
keep-or-shutdown decision when it settles, serialized against everything
else touching the registry, so the pool can never end up over limit even
though the sweep that ran at startup couldn't see the reclaim coming.

## Device state machine

One shared lifecycle for both platforms; drivers map onto it, never extend it:

```
provisioning → ready → leased → reclaiming → ready/shutdown → deleted
      ↓                              ↓               ↓
      └──────────→ quarantined ←─────┴───────────────┘
                        ↓
                 ready/shutdown/deleted
```

A device created under `lease.identity: fresh` serves one lease. Its lease end
skips the purge: `reclaiming → shutdown` (driver shutdown), then
`shutdown → deleted` (driver destroy). `mayBeGranted` in `domain.ts` keeps a
spent fresh device out of every grant path, including in the window between
those two commits. A failed delete enters quarantine from `shutdown`, and
quarantine retries the delete, never a reclaim.

All transitions go through the core. `simlock status` reads identically for
iOS and Android because of this.

A warm device is derived inventory, not a state: any registry-managed,
unleased `ready` device is warm. Release always purges while the device is
`reclaiming`; it returns to `ready` when capacity permits, otherwise it is
shut down, or, if the purge itself failed, `quarantined`. Active demand may
evict deterministic LRU warm inventory before starting requested work,
without bypassing the FIFO head.

### Quarantine: present but not grantable

`quarantined` is the shared disposition for a device the core cannot vouch
for right now: it stays in the registry and keeps counting against running
capacity (so it is not silently over-provisioned away), but it is invisible
to every grant path, because `AcquisitionPlanner` and the warm-pool eviction
helpers select targets by exact state (`state === "ready"`), never by
excluding known-bad states. Anything that needs "in the registry, counts
against capacity, not grantable" is expressed by adding its own entry into
`quarantined`, not by inventing a second state: the release-time purge
failure (`reclaiming → quarantined`), a fresh device's failed delete
(`shutdown → quarantined`), and the stalled-transition timeout
(`provisioning → quarantined`, all owned by `QuarantineCoordinator`) are its
three entries. The latter fires from `simlock doctor`'s `stalled-transition`
finding — a `provisioning`/`reclaiming` device whose time in that state has
outrun a driver-derived threshold, meaning the driver call meant to resolve
it never did and the registry's view has diverged from the driver's. Safer
to quarantine than re-drive: the device may be mid-erase.

`QuarantineCoordinator` retries the triggering operation on a `Clock`-driven
backoff (`warmPool.quarantine` config: retry count, backoff, multiplier, cap).
A successful retry returns the device to `ready` (or `shutdown`) and it
rejoins the warm pool; exhausting the retry budget destroys it
(registry-only, never merely `shutdown`, since `shutdown` is reusable warm
inventory to `AcquisitionPlanner` and would silently reintroduce a dirty
device). `device.purge-failed` still fires as it always did; `device.quarantined`,
`device.quarantine-recovered`, and `device.quarantine-abandoned` are the
follow-up facts (see [EVENTS.md](EVENTS.md)).

## Fresh-state strategy (benchmarked 2026-07)

Measured on an Apple Silicon / 32 GB machine, iOS 26.5, Android emulator 36.1.9:

| Platform | Strategy | Time to ready |
|---|---|---|
| iOS | create / clone / erase (prep step) | < 1s each |
| iOS | boot + `bootstatus` wait | ~30s, dominates everything |
| Android | cold create or `-wipe-data` boot | ~30s |
| Android | quickboot snapshot restore | **~3.7s** |

Conclusions baked into the drivers:

- **iOS `reclaim` = shutdown + `simctl erase`.** All prep strategies are
  sub-second and tied; erase is the simplest to operate (no golden-device
  bookkeeping). Boot time is a fixed ~30s floor — only a warm pool of
  pre-booted devices can beat it.
- **Android `reclaim` = restore an explicit immutable clean-baseline snapshot**,
  with `-wipe-data` as the fallback. The first clean boot captures and validates
  a named baseline, then restarts from it with automatic snapshot saving
  disabled before the first grant. Its compatibility tag is captured from the
  post-boot AVD configuration because the emulator normalizes `config.ini`
  during first boot. Snapshots are ~1.3 GB each and
  invalidate *silently* on AVD-config / system-image / emulator-version
  changes, so the driver tags the baseline with a config hash and rebuilds it
  before reuse after invalidation.
- **Readiness probes**: iOS `simctl bootstatus` (variance observed up to
  ~30% — use generous timeouts, not a hard SLA). Android:
  `sys.boot_completed == 1` AND (`init.svc.bootanim == "stopped"` OR unset),
  then `adb emu avd path` must name the device's own `<deviceRoot>/<avd>.avd`
  (whole path, or the same directory by `realpath`). Whatever answers on the
  serial is whoever holds the console port, so a collision fails the boot with
  `DriverCrashError` before a mark or a baseline capture touches that emulator,
  and a shutdown or destroy that follows in the same daemon process sends it
  no `emu kill`; an AVD name proves nothing (safety rule 8). Not covered yet: a
  shutdown or destroy of a device that was never refused (or after a daemon
  restart) still sends `emu kill` to its stored serial unchecked, and reclaim's
  `emu avd snapshot load` goes to the serial before its readiness wait checks it.

## Leases

There is **one kind of lease**, on every transport ([ADR
0004](adr/0004-ttl-first-leases-on-every-transport.md)).

- **A lease is a TTL and nothing else.** Every lease carries `ttlMs` and a
  `ttlDeadline` (`expiresAt` in HTTP bodies), set at grant from the request's
  `ttlMs` or from `lease.defaultTtlMs`, and capped at `lease.maxTtlMs` — asking
  for more is `BAD_REQUEST`, not a silent clamp. `LeaseLifecycle` arms one
  expiry timer per lease and re-arms it on renew through
  `registry.renewLease()` (not a direct `expiryScheduler.replace()`), so the
  persisted deadline never goes stale and a restart mid-lease restores the
  renewed deadline rather than the grant-time one. The record stores its
  `ttlMs` too — the width it was granted with, or last renewed with when a
  renew named one — because a body-less renew re-applies that width rather than
  falling back to `lease.defaultTtlMs`. It also carries `lastRenewedAt`, a
  **stored** field written at grant and on every renew, which is what `simlock
  status` renders as "last renewed". That is a new field rather than a rename
  of `lastHeartbeatAt`: the old one was never stored at all, it was derived at
  the dispatcher as `ttlDeadline - heldTtlBackstopMs`, and that arithmetic
  cannot survive per-lease TTLs.
- **The only thing that keeps a lease alive is `lease.renew`.** It is an
  ordinary client-initiated operation, so it works identically on the unix
  socket, over HTTP, over MCP, and through a gateway that forwards it to the
  owning worker. There is no daemon-initiated heartbeat, no capability to
  declare, and no second deadline behind the first.
- **Connection close means nothing to a lease.** The daemon keeps no
  per-connection lease state and releases nothing when a connection closes, on
  any transport. Nothing is swept at daemon startup either — a restart does not
  prove a holder is dead. So a gateway hop, a suspended laptop, or a daemon
  upgrade costs a client its stream and not its device. It can still cost the
  client: the typed client does not reconnect (ADR 0003 §10), so a `simlock
  lease` holder exits `1` on a dead connection and something has to renew that
  still-standing lease from a new connection before its deadline. The lease
  outliving the connection is the daemon's guarantee; picking it back up is the
  frontend's job.
- **"Holding" is a frontend policy over that one lease.** `simlock lease` and
  the MCP session both renew at one third of the lease's TTL — sending no TTL
  of their own, so every renew re-applies the lease's stored `ttlMs` and the
  deadline keeps its original width — and release on exit. A renew that fails
  transiently on a live connection is simply retried on the next tick; one
  answered `UNKNOWN_LEASE` means the daemon has already ended the lease, and
  the holder stops exactly as a `lease-lost` push would stop it. The CLI holder
  additionally watches its parent through the `ParentWatch` port and
  self-terminates if it dies, so a crashed agent's backgrounded `simlock lease`
  cannot outlive it by getting reparented — see
  [known-pitfalls.md](known-pitfalls.md). `--detach` is the absence of that
  policy, not a different lease. The daemon neither knows nor cares which
  policy a client follows.
- **The cost of that simplicity, stated once:** a holder killed with `SIGKILL`,
  or lost with its machine, runs no release, so its device stays leased until
  the deadline — at most the lease's own TTL after its last renew:
  `lease.defaultTtlMs` unless the request asked for more, never more than
  `lease.maxTtlMs`. A short default TTL is the bound, deliberately chosen over
  reintroducing per-connection lease state that HTTP and a gateway could never
  honour anyway (ADR 0004, "Alternatives considered"). See
  [known-pitfalls.md](known-pitfalls.md#a-sigkilled-lease-holder-keeps-its-device-until-the-ttl-expires).
- One lease per agent in v1; no atomic multi-device acquisition (documented
  deadlock risk if two devices are taken sequentially).

### Release hands the purge off

A release is two halves with very different costs. The first is a registry
commit inside the serialized decision section: the lease record is gone,
`lease.released` is emitted, and the device is `reclaiming`. The second is the
driver-side purge — an iOS `simctl erase` runs tens of seconds, an Android
snapshot restore comparably — and it carries no information the releasing
caller can act on. So `LeaseReleaseCoordinator` commits the first half, hands
the second to `WarmPoolCoordinator` without awaiting it, and returns. An agent
releasing over MCP or the CLI gets its turn back immediately instead of
blocking on a device it has already given up, and an expiry frees its device
the same way.

The device is not lost track of while that runs. It is `reclaiming`, so it
still counts as running capacity and is invisible to every grant path
(`AcquisitionPlanner` selects by exact state), and the reclaim holds a
`reclaim` operation claim for its whole duration — which is how
`StartupConverger#recoverInterruptedReclaims` and `simlock doctor`'s
stalled-transition finding both tell a live purge from an abandoned one. A
waiter queued for exactly that device is granted the moment the purge settles:
the coordinator re-notifies acquisition *after* releasing the claim, because
the warm pool's own notification fires while the device is still claimed and
therefore still unselectable.

Three things still wait for the purge, deliberately:

- **An operator reset.** `NukeService` only acts on `ready`/`shutdown`
  records, so a device left mid-reclaim would be skipped by the very reset
  meant to take it down. `beginMaintenance` drains in-flight background
  reclaims, and the maintenance-authorized release awaits its own inline.
- **A graceful `simlock daemon stop`.** It drains the in-flight reclaims
  (before disposing timers, so a purge that settles into quarantine still gets
  its retry cancelled), leaving the pool in the same settled shape an inline
  reclaim used to.
- **The next start, if the daemon died instead.** Interrupted reclaims are
  recovered from the registry as before.

The trade the backgrounding makes is where a purge failure surfaces: the
caller is gone, so it cannot be rejected to. It does not go missing — a driver
purge failure is already `QuarantineCoordinator`'s job and stays visible as
`device.purge-failed` plus a `quarantined` device — and anything unexpected
beyond that is logged by the coordinator rather than left unhandled.

### Lease subsystem boundaries and wiring

The lease subsystem is assembled from focused modules. `LeaseEngine` is the
composition root and compatibility facade: it wires one shared
`SerializedDecision`, `DeviceOperationClaims`, `DriverCatalog`, registry, and
capacity coordinator into these direct transactional call chains:

- `LeaseRequestBook` stores every lease request in the registry before the
  queue sees it, answers a repeat under the same `(requesterId,
  idempotencyKey)` with the stored result or the wait still open, and writes
  the result once that wait settles. The HTTP request resource reads requests
  through it; a gateway's `FleetLeaseCoordinator` runs the same book over an
  in-memory store.
- `WaitQueue` owns pending demand, FIFO order, request timeouts, and progress;
  `AcquisitionPlanner` makes read-only grant/provision/boot/eviction plans;
  `DeviceProvisioner` and `ManagedDeviceLifecycle` perform the resulting driver
  work and registry transitions.
- `LeaseLifecycle` owns grant, renewal, release commits, and expiry scheduling.
  A release passes its committed result directly to `WarmPoolCoordinator`,
  which performs reclaim and warm-pool disposition — without the releasing
  caller waiting on it (see "Release hands the purge off").
- `CapacityCoordinator` owns provisioning and running reservations while the
  configured `CapacityStrategy` decides the limits. `DeviceOperationClaims` excludes
  overlapping boot, eviction, cleanup, and nuke operations per device.
- `CleanupReaper` evaluates pure rules and directly calls
  `CleanupActionExecutor`; the executor revalidates registry ownership,
  lease/state safety, and delegates the driver operation to
  `ManagedDeviceLifecycle`.
- `StartupConverger` settles every lease request the previous process left
  open as failed, then runs TTL-timer restoration, interrupted-reclaim
  recovery, and running-capacity convergence in that order. `NukeService`
  coordinates lease release, pending-request cancellation, and
  registry-scoped reset operations.

The serialized decision gate protects only short read-decide-commit sections.
Driver work remains outside it. One `state.json` write does sit inside it: a
new lease request is stored in the same section that checks it is unique, so
two concurrent requests under one key cannot both pass. A file write costs
nothing next to the device work a lease waits on. Component boundaries use direct calls for
transactions; capacity-changing components notify the FIFO acquisition
coordinator directly. The event bus remains only for post-commit facts and
observers.

The daemon consumes role-specific lease, capacity, queue, cleanup, doctor, and
nuke interfaces rather than duplicating core decisions in the CLI or server.

## Leased-device health and crash recovery

`Doctor.reconcile()` already knew a leased device could crash: its
`expectedRunState` maps `leased -> "running"`, so a leased device whose
process an operator kills from outside simlock produces a
`foreign-state-change` finding. What was missing was anything that acted on
that finding at the moment it mattered. `reconcile()` only ran at daemon
startup and from an explicit `simlock doctor`, so a crash between those
points sat undetected indefinitely. And even a `doctor --fix` run that saw it
couldn't repair it: `#fixForeignStateChange` bails on a leased device, the
cleanup reaper filters leased targets centrally before a rule ever runs, and
`ManagedDeviceLifecycle`'s registered-target guard rejects any operation on a
device a lease references. Every repair path existed specifically to leave a
leased device alone — correctly, for everything except this one case.

`LeaseHealthMonitor` closes that gap with a `Clock`-driven tick, modelled on
`CleanupReaper`: each pass polls `listManaged()` once per platform that has
leased devices, and classifies every `leased` device against that reality.
`ObservedRunState` is three-valued, not two, because the two drivers'
"stopped" and "still coming up" look identical for a moment: `simctl` reports
`Booting` / `Shutting Down`, and an emulator reads offline in `adb devices`
before it answers `getprop`. Treating either as evidence of a crash would
misfire on every ordinary boot. So `transitioning` is never a crash
observation — it leaves the device's counter untouched — and only
`health.stableObservations` consecutive `stopped` reads count as one; a single
`running` observation resets the counter to zero. The monitor would rather
miss a tick's worth of time than reboot a device that was merely still
shutting down.

The device stays `leased` for the entire recovery and no `recovering` state
was added to `legalTransitions`. A new state would have meant teaching
capacity accounting, the cleanup reaper's safety filter, doctor's
`expectedRunState`, CLI/status rendering, and the persisted state file about
it — five places to keep in sync for what is, from the registry's point of
view, not a state at all: it's a lease continuing on the same device. In-flight
recovery is tracked instead as fields on the `DeviceRecord`
(`recoveringSince`, `recoveryAttempts`) plus an exclusive `"recovery"` device
operation claim, so it can never overlap a boot, eviction, cleanup, or nuke on
the same device. No capacity reservation is taken for the reboot either:
`RUNNING_STATES` already counts `leased` as running, so the slot was never
given up in the first place. And the driver call is `makeReady`, already
idempotent for an already-booted device — this reboots, it does not
re-provision or erase, because a crash killed a process, not the disk image;
the agent's installed apps and data are still there to resume.

Provenance drift — `erased` / `mark-mismatch` / `durable-mark-missing`, the
same check doctor runs — is only ever trusted while the device is observed
`running`. A stopped device can't be read reliably: Android's erasable mark
lives on the userdata partition, reachable only over `adb` while the emulator
runs. So the monitor only evaluates it in the branch that also resets the
crash counters, right after confirming the device answered — never against a
device it just found stopped, where the same mark would be unreadable or
stale.

Recovery gives up — releasing the lease with reason `device-lost` so the
device returns to the pool — in exactly three cases: the device is absent
from driver reality entirely (`device-missing`, itself debounced by
`stableObservations` so a driver hiccup doesn't cost a lease), provenance
drift is detected (rebooting a device whose data provably isn't the agent's
anymore would be worse than losing the lease), or `health.maxRecoveryAttempts`
reboot attempts have already failed. All three emit `device.recovery-failed`
(with the reason) and then route through the same `DeviceLostReleaser`, so
the lease-release path — and its `lease.released { reason: "device-lost" }`
fact — stays the single place a lease ends, regardless of who decided it
should.

None of this is silent. A reboot resumes the lease, but it cannot resume
whatever the agent had running *inside* the device when it died — a launched
app, a `log stream`, an Appium/XCUITest session, a port forward — simlock has
no way to know that state existed, let alone restore it. So the monitor emits
`device.crash-detected` the moment a crash is confirmed and `device.recovered`
once the reboot passes readiness; the daemon pushes both to every live
connection whose principal owns the lease (`device-unhealthy` /
`device-recovered` on the wire, ADR 0003 §8 and ADR 0004 §5) — so the holder
learns its device blinked instead of quietly finding its session gone. A
polling-only HTTP client, which has no connection to push to, reads the same
facts from the `notices` array on `POST /v1/leases/{id}/renew`; that buffer
(`LeaseNoticeBuffer`, `src/http/notices.ts`) is HTTP-side frontend state, not
part of the socket `lease.renew` response.

A give-up is not a separate push: it ends the lease through the normal
`lease.released` path, so the holder learns about it the same way it learns
about any other lease loss.

The monitor starts only after startup convergence completes
(`DaemonServer#start`, after `#converge()` returns) — the same claim-first
ordering the daemon already uses. It is also what keeps this feature from
needing a special case in the lease-lost subscription wiring: nothing can
emit `device.crash-detected` or `device.recovered` during the convergence
window, because the health monitor is the only emitter and it isn't armed
yet.

## Cleanup: many rules, one reaper

Cleanup **rules** are pure decision logic: given a read-only registry view
(device states, last-lease time, disk/RAM stats), they *propose* actions.
A single **reconciliation loop** collects proposals from all registered rules,
dedupes and orders them, and filters obvious unsafe targets. It calls
`CleanupActionExecutor` directly; that executor independently revalidates
registry ownership, lease/state safety, and claims before delegating to the
shared managed-device lifecycle.

v1 rules — the tiered cleanup:

1. idle > T1 → `shutdown` (reclaim RAM)
2. idle > T2 → `destroy` (reclaim disk); under disk pressure (free space
   below `diskPressure.freeBytesThreshold`) `idle-destroy` uses T1 instead of
   T2, so a full disk shortens the wait to reclaim it — the rule reads
   `diskFreeBytes` off the view itself rather than depending on the
   `disk.pressure-detected` event.

Rules are registered in a static in-code list; adding one is a new file plus
one registration line. `--rule <name>` selects a registered rule by name.
Reaper triggers are observer subscriptions to `lease.released`,
`disk.pressure-detected`, and `daemon.started`, plus a periodic tick. The
reaper itself emits `disk.pressure-detected` (edge-triggered, once per
crossing) as a post-commit fact for observers — never as the mechanism that
drives `idle-destroy`'s own behavior. Every successful action emits its rule
and reason in `cleanup.executed`; `simlock cleanup --dry-run` previews
proposals.

## Event bus

An in-process, typed event bus carries **past-tense business facts**
(`device.reclaimed`, `lease.expired`). Observers — cleanup triggers,
logging/metrics, `simlock events --follow` — subscribe to it. Warm-pool
reclaim/disposition, cleanup execution, startup convergence, eviction, and
nuke remain explicit direct component call chains.

The bright line: **events for reactions, direct calls for transactions.** The
lease workflow (request → queue → provision → ready → grant) is an explicit
call chain that *emits* events at each transition but never *waits* on them.
Events are emitted post-commit only; handler failures are isolated from
emitters. See [EVENTS.md](EVENTS.md) and
[agent-rules/events.md](agent-rules/events.md).

### Driver facts reach the bus through diagnostics, never directly

Drivers must never depend on the event bus (architecture rule 5 — a driver is
not an observer of its own facts). Where a driver needs to report something
the daemon should turn into a bus event, it reports it through its own
callback option instead — the iOS driver's `onSlimmed` for `device.slimmed`,
the Android driver's `onDiagnostic` for `snapshot-cold-boot` and unreadable
device-profile sources. `src/daemon/main.ts` wires these at construction time
(`discoverDrivers`).

### Components: one installer in the core (ADR 0010)

A component is an iOS simulator runtime or an Android system image. Drivers
install components; they do not decide when. `resolveSpec` never downloads:
when a download could satisfy a request it throws `RuntimeMissingError` with
`downloadable: true` and `component`, the string to install — a version, or a
driver's word for "newest" (`latest` on iOS; the bare major of a model's upper
bound when the model has one). For installs a driver offers two verbs and an
estimate (`listComponents` and `removeComponent` are below):

- `findComponent(component)` — a read: the installed version and its receipt,
  or nothing. A string that is not a version answers nothing.
- `installComponent(component, { onProgress, signal })` — runs the platform
  installer (`xcodebuild -downloadPlatform`, `sdkmanager --install` with its
  license retry) with no timeout of its own, ends it when `signal` fires,
  verifies the result against a fresh read, and answers `installed` or
  `already-installed` by whether the receipt it ends with existed before the
  run. Progress is the percentage the installer prints
  (`src/drivers/installer-process.ts`, shared by both drivers).
- `componentFootprint` — the fixed disk estimate (~8 GiB on the CoreSimulator
  volume for iOS, ~2 GiB on the SDK root for Android) and the path it lands on.

A receipt names the installed thing itself and is opaque to the core: the
runtime image identifier and build on iOS, the package, revision and a stamp of
the image's `source.properties` (file identity and modification time) on
Android. One function per driver builds it.

`ComponentInstaller` (`src/core/component-installer.ts`) is the only caller of
`installComponent`. `src/daemon/main.ts` builds one with the drivers, a
`DiskSpaceGuard`, the registry, the bus, the shared `SerializedDecision` and
`downloads.timeoutMs`, hands it to the lease engine and to the `Dispatcher`
(through `DaemonServer`), and closes it on dispose before the drivers are
disposed. A call for a platform with no driver, or after `close()`, is refused
at the door; any other call is admitted synchronously (`onAdmitted`) before it
is queued or joins an install. It keeps one queue per platform, first come
first served; iOS and Android install at the same time. A call naming a
component that is already waiting or running joins that install and gets its
outcome or its error. When a call reaches the front, the installer runs the
call's `stillNeeded` check, then asks `findComponent` (found: `already-installed`,
no reservation, no event), then reserves the footprint with the
`DiskSpaceGuard` — reservations of running installs on both platforms are
counted together, and one that does not fit is refused with
`InsufficientDiskSpaceError` before the driver is called — and only then emits
`component.install-started` and calls the driver. On `installed` it stores a
`ComponentRecord` (platform, version, time, receipt) in the registry inside the
decision gate, then emits `component.installed`. Progress fans out to every
joined call; a call behind another install hears `waiting`. When an install
starts running, its calls hear `downloading` with no percentage before the
driver reports anything, and a call that joins a running install hears that
install's latest report at once.

Every call has one budget, `downloads.timeoutMs`, measured on the `Clock` from
the moment it arrives; waiting spends it and nothing restarts it (architecture
rule 11). A waiting call that runs out leaves alone with
`ComponentInstallTimeoutError` (`DOWNLOAD_TIMEOUT`), and its install leaves the
queue when it was the last call on it. A running install is aborted at the
deadline of the oldest call joined to it, and every joined call fails then.
The platform's next install waits until the aborted driver run returns.

The lease path reaches the installer directly (architecture rule 5):
`LeaseAcquisitionCoordinator` resolves the spec, and when the runtime is
missing, downloadable, and the request may download, calls the installer with
`stillNeeded` = "`resolveSpec` still throws `RuntimeMissingError`" and resolves
once more. The installer's reports reach the requester as the `downloading`
lease-progress stage, sent through the wait queue like every other stage:
`waiting` becomes `waiting: true`, the install's own reports `waiting: false`
with the percentage rounded down, and a report equal to the last one sent is
skipped. Without `allowDownload` the first error stands. Warm-pool
re-readiness and startup convergence never reach the installer (safety rule 4).

The operator path is `component.install` (ADR 0010 §6), an admin operation
with input `{ platform, version }`; `version` is bounded by the contract
schema (1 to 64 characters, no whitespace or control character, no leading
`-`) before it
reaches a driver, which builds an installer argument from it (safety rule 10).
The `Dispatcher` handler asks `effectiveAllowDownload(policy, true)` — the
command is the consent, so only `downloads.policy: "never"` refuses it, with
`DOWNLOADS_DISABLED` and before the installer is reached — then calls the
installer with the session's principal as `requesterId`. The installer's
progress becomes the request-scoped `component-progress` push (`waiting`, or
`downloading` with the driver's percentage as a `fraction`); the socket
transport writes it as frames keyed by the request id, and
`POST /v1/components/install` as SSE `progress` events. That route commits
to its stream at the installer's `onAdmitted` (the session's `onStarted`),
the same decision point the exec route takes at a spawn, so a refusal before
it is a JSON error with its status and everything after is a terminal SSE
event. Neither transport stops the install when its client goes away; a
repeat joins it. A gateway answers `UNSUPPORTED_IN_GATEWAY_MODE`; relaying to
workers is a separate gateway operation.

The listing is `component.list` (ADR 0010 §8), an agent read with input
`{ platform? }`, behind `simlock component list`, `listComponents` on the
client and `GET /v1/components`. Each driver answers
`listComponents()`: one entry per installed component with its version, its
`variant` (the driver's own words, carried unread: the build on iOS, tag and
ABI on Android), its size when readable, its receipt from the same function
`findComponent` and `installComponent` use, and `foreignDevices`. It is
read-only, never downloads, and every process it starts is bounded, like
`listCatalog`. iOS reads `simctl runtime list -j` (iOS images only) and
counts devices per runtime in the default device set with an unscoped
`simctl list -j devices`, the one unscoped call besides the pre-root path's.
One function, `devicesPerRuntime`, decides which of them count for the
listing and the removal alike: only a device whose entry carries
`lastUsedAt`, so the never-used simulators macOS creates for every installed
runtime do not block a removal (#241).
Android reads the installed images, sizes each directory with
`Filesystem.directorySize`, and counts AVDs in the user's own AVD home whose
`config.ini` names the image's directory. On both platforms a foreign-device
read that fails rejects the listing rather than undercount. Counting foreign devices is the
only place a driver looks at devices outside its root; it reads them and
never writes there (safety rule 1).

`ComponentInstaller.list(platform?)` merges each driver's listing with the
registry: `installedBySimlock` is true when a `ComponentRecord` of that
platform has a receipt equal (`sameReceipt`) to the entry's, and
`installedAt` is that record's time — the record is the only proof (ADR 0010
§5, safety rule 8). `devices` counts registry devices of that platform and
version in any state but `deleted`, plus every device `DeviceProvisioner` has
claimed and not registered yet (below); the core cannot tell variants apart, so
two variants of one version show the same count. A driver whose listing
rejects is left out and logged, and the other platform is still listed.
Entries are ordered by platform, then version, then variant. A gateway
answers `UNSUPPORTED_IN_GATEWAY_MODE`.

Removal is `component.remove` (ADR 0010 §8), an admin operation with input
`{ platform, version, dryRun? }`, behind `simlock component remove` (which
confirms or requires `--yes`, safety rule 5), `removeComponent` on the admin
client and `DELETE /v1/components/{platform}/{version}` (`?dryRun=true`, one
JSON answer). The dispatcher passes the session principal as `requesterId`
and turns `ComponentInUseError` into `COMPONENT_IN_USE` with its two counts
as details. `ComponentInstaller.remove` is the only caller of
`Driver.removeComponent`:

1. **Prove ownership.** The registry's `ComponentRecord` of that platform and
   version, and an entry of the driver's listing — the same `#listDriver`
   `list` answers from (architecture rule 10) — whose receipt equals the
   record's. Either missing is `ComponentNotOwnedError`
   (`COMPONENT_NOT_OWNED`). A listing that rejects rejects the removal: an
   unreadable foreign count is never "no users".
2. **Refuse users.** `devices` or `foreignDevices` above zero is
   `ComponentInUseError` (`COMPONENT_IN_USE`).
3. **Refuse a busy platform.** Anything in the platform's install queue, or a
   removal already holding its turn, is `ComponentBusyError`
   (`COMPONENT_BUSY`). A dry run stops here with `would-remove` and the
   listed size; it has run every check.
4. **Take the turn.** Checked and taken with no `await` between them; while
   a removal holds it, `#pump` starts no install on that platform, and an
   install that arrives is told it waits.
5. **Mark, inside the decision gate.** It counts Simlock's devices again and
   marks the platform and version as being removed. Device records are
   created in one place, `DeviceProvisioner.provision`, which first calls
   `ComponentInstaller.claimProvision(spec)` inside the gate: a marked
   component refuses with `ComponentBeingRemovedError` (a
   `RuntimeMissingError`, so `RUNTIME_MISSING`) before the driver creates
   anything, and the lease path rejects the request instead of retrying. An
   unmarked one counts the claim as a Simlock device until the device's
   record is committed, in the same gate section, or the provision fails. So
   the gate orders every new device against every removal: either the
   removal's count sees it, or it sees the mark.
6. **Remove.** `driver.removeComponent(receipt, { signal })`, then delete the
   record inside the gate, then emit `component.removed`. A failure is logged
   with who asked, keeps the record, and rethrows. The mark and the turn live
   in one record, `#removals`, which every exit clears. `close()` aborts a
   running removal through its signal, which answers `DAEMON_STOPPING`, and
   resolves once the driver call has returned.

Every driver's `removeComponent` is `removeListedComponent` (`src/core/driver.ts`)
over its own listing: prove the receipt again, refuse a foreign user again,
run the platform step under `COMPONENT_REMOVAL_TIMEOUT_MS` (five minutes) and
the signal, and list again to verify the component is gone. Both platform
steps run through `runBoundedProcess` (`src/drivers/installer-process.ts`),
which ends the process `SIGTERM` then `SIGKILL` and answers only once it has
exited. iOS runs `simctl --set <root> runtime delete <image>` without
`--keep-asset` (the `--set` from `#scopedSimctlArgv`, like every scoped call),
then reports `residue`: how many never-used default-set simulators of the
runtime, counted in the listing taken before the delete, are now unavailable
(Simlock deletes none of them; `xcrun simctl delete unavailable` does), and,
after reading the asset store (#79), that the build's download is still
there, each when it applies; `simlock simctl runtime delete` stays refused and
points at `simlock component remove`. Android runs
`sdkmanager --uninstall <package>`. A second
Simlock instance's devices and a foreign device created after the driver's
last count are not seen; see KNOWN-PITFALLS.md.

#### Through a gateway

`worker.install-component` (ADR 0010 §7) only installs through a gateway: a
worker refuses it with `UNSUPPORTED_IN_WORKER_MODE` (ADR 0012 §2), and no
worker ever receives it over an uplink, which is why it moves no protocol
version. Its input
is `{ platform, version, workers }`; `version` runs `component.install`'s own
schema and `workers` is `"all"` or 1 to 64 distinct ids. One function,
`relayComponentInstall` in `src/gateway/component-relay.ts`, does the
fan-out; `GatewayDispatcher`'s handler only calls it.

- **Targets.** One check, `askable`, says whether a worker can be asked: its
  view is `connected`, its link is reachable, and its view carries
  `downloads.timeoutMs`, which is absent until that worker's `config.get` has
  been read. Under `"all"` every other known view is `skipped`; a named id
  with no view fails the call with `UNKNOWN_WORKER`, and a named worker that
  is not askable with `WORKER_UNREACHABLE`, both before anything is sent.
  Drain is not read.
- **The call.** Every target's own admin client gets `installComponent` at
  the same time, over the uplink session the link already holds. The
  session's `onStarted` fires once the targets are resolved, which is where
  `POST /v1/components/install` with `workers` commits to its stream. Each
  `component-progress` update is passed to the session with the worker's id,
  and the socket transport writes it with `workerId` on the push.
- **One outcome per target** (architecture rule 12). The worker's answer, the
  gateway's client rejecting with `DAEMON_CONNECTION_LOST` (the uplink
  closed), and a backstop timer each settle the target, first one wins, and
  everything after it is dropped, progress included. The backstop is that
  worker's `downloads.timeoutMs` plus `INSTALL_BACKSTOP_MARGIN_MS` (one
  minute), set on the `Clock` when the call is sent and never restarted
  (rule 11); it and the uplink closing both answer `unknown`. The relay never
  cancels a worker's install. A success keeps the worker's outcome and
  version, `DOWNLOADS_DISABLED` is `refused`, and any other error is
  `failed` with the worker's code and message, the message cut to the
  contract's bound and an answer that still does not fit it `failed` as
  `INTERNAL` (safety rule 10).
- **The catalog.** After an `installed` answer the relay awaits that link's
  `refresh({ includeCatalog: true })` before the result counts.
  `WorkerLink#refresh` resolves only once a refresh that started after the
  call has finished, also when it coalesced into a queued one, so the fleet
  catalog lists the component by the time the relay answers. The refresh is
  best effort: one that fails, or a link that closed, leaves the view as it
  was, and the next refresh (an event, a reconnect, or the periodic tick)
  brings the component in.
- The relay keeps nothing: no request is remembered for a worker that is
  away, and nothing is retried.

## External APIs behind interfaces (ports)

Every external API the app touches gets its own type/interface (a *port*),
and application code depends only on that interface — never on the underlying
API directly. This applies to the filesystem, process execution (shelling out
to `simctl`/`adb`/`emulator`), the clock/timers, sockets/IPC, system
stats (CPU/RAM/disk), and watching another process for exit:

```
Filesystem   — read/write/delete/stat/disk-free
ProcessRunner — spawn/exec/kill, capture stdout/stderr
Clock        — now(), timers (no direct Date/setTimeout in logic)
SystemStats  — cpu count, total RAM
HostInfo     — operating system, its version, CPU architecture (`sw_vers` on macOS)
IpcConnector / IpcListenerFactory — connect to and host daemon IPC endpoints
DaemonLauncher — detached daemon startup with append-only combined logs
Logger       — debug/info/warn/error(message, fields) plus child(module) scoping
ParentWatch  — watch a pid, notify once on exit (lease holder self-termination)
```

Real implementations are thin adapters wired up once at daemon startup;
tests get in-memory/fake implementations (virtual filesystem, scripted
process runner, manually-advanced clock). This is what makes the core —
queueing, TTL expiry, cleanup rules, capacity math — testable deterministically
and without touching real simulators. Drivers are tested the same way: a
scripted `ProcessRunner` replays recorded `simctl`/`adb` output.

Rule of thumb: if a module imports `fs`, `child_process`, or reads
`Date.now()` directly, it's a bug — depend on the port instead
(see [agent-rules/architecture.md](agent-rules/architecture.md)).

The daemon keeps IPC lifecycle separate from request handling. `DaemonEndpointHost`
claims an endpoint, verifies live peers, removes confirmed stale entries, and owns
listener shutdown. `DaemonServer` only accepts abstract IPC connections and routes
protocol requests to the role-specific `LeaseCommands`, `QueueControl`, and
`CapacityReader` interfaces. On the client, `IpcDaemonConnection` owns framing and
request multiplexing, `IpcDaemonConnector` performs the hello handshake, and
`DaemonStartupCoordinator` uses `Clock` plus `DaemonLauncher` to retry a missing
or refused daemon. This keeps transport, detached-process logging, and startup
policies replaceable without introducing an ambient dependency container.

### Startup: claim first, converge after

Reachability does not depend on startup recovery work. `DaemonServer#start`
claims the socket (`DaemonEndpointHost#start`) before running `startDaemon`'s
`converge` callback, which runs `doctor.reconcile()` and
`leaseEngine.convergeRunningCapacity()` concurrently rather than one after the
other: `doctor.reconcile()` is pure reconnaissance that already runs
interleaved with live lease/reclaim activity whenever a client issues
`doctor.run` mid-session (it shells out per driver/device, then at most flags
drift for a later `--fix`), so overlapping it with startup's own registry
work introduces nothing this codebase doesn't already do elsewhere. Neither
call awaits a device reclaim inline any more (#43) — a release's reclaim runs
in the background once the release commits — so what's left on this path is
comparatively fast: per-driver/device reconnaissance plus whatever unleased
interrupted-reclaim recovery and capacity-sweep shutdowns
convergence itself still performs inline. Two consequences follow from
claiming first:

- A second daemon racing to start now discovers `DaemonAlreadyRunningError`
  from the claim itself, before it does any device work — not after, as when
  convergence ran first.
- `hello` and `status.get` answer immediately, `status.get` reporting
  `health: "starting"` while convergence is in flight and `"running"` once it
  resolves. Every other request type parks on the same readiness promise
  `#awaitReady` awaits, and proceeds normally once convergence completes; no
  request can observe half-converged state, and in particular no lease is
  granted before convergence finishes. A slow startup becomes a slow response
  instead of `DaemonStartupCoordinator`'s client-side timeout firing a false
  failure for a daemon that was starting normally.

If convergence itself throws, `start()` stops the daemon (closing the
listener and any connections that raced in during convergence) rather than
leaving it accepting connections it can never serve; parked requests reject
with `DAEMON_STARTUP_FAILED` instead of hanging. Because the two converge
calls run concurrently, one throwing does not cancel the other — `Promise.all`
still attaches a handler to both, so neither can produce an unhandled
rejection, but a straggling `convergeRunningCapacity()` step can keep running
briefly after `stop()` has begun. Nothing it can still do (registry-only
destruction, never touching a leased device) is unsafe to have in flight
during shutdown; it just means "stopped" is not instantaneous relative to the
failure being reported. `health` itself does not grow a third state for this:
`running` means convergence finished, not that every backgrounded reclaim it
kicked off has settled — `simlock status` already reports each device's own
state (`reclaiming` included), so a separate aggregate would duplicate
information already visible per-device rather than add any.

Operational logging is a separate concern from the event bus (ADR 0006): two
records, and no fact is copied from one into the other. `simlock events`
carries business facts (lease granted, device cleaned up, …), while the
`Logger` port writes structured JSON lines saying what the daemon was asked to
do and what went wrong. The log records:

- **One `operation` line per dispatched call**, built in exactly one place:
  `runDispatch` (`src/daemon/dispatch.ts`), through the `observe` hook both
  dispatchers pass (`logger.child("dispatch")`). It names the operation,
  `principal`, `role`, `durationMs`, `leaseId`/`requesterId` from the
  validated input when present (nothing else from the input, nothing from the
  output), and on failure `code`, plus `message` once the input has passed
  its schema (before that the message quotes raw wire input). Level follows the operation's
  contract `effect`: a `write` success is `info`, a `read` success `debug`, a
  failure `info`, an `INTERNAL` failure `error`. A call refused before its
  handler (`UNKNOWN_REQUEST`, `BAD_REQUEST`, `FORBIDDEN`) gets the line too.
  `codeOf` is injected (`classifyError`) so `dispatch.ts` stays free of
  `src/core`. The HTTP app's own `request` line stays as the transport's
  record; `daemon.stop` and `hello` are answered by the socket server and keep
  their own lines.
- **One line per handled background failure** — a boot, an eviction, a
  quarantine retry, a warm-pool disposition, a scheduled cleanup run, a lease
  expiry — from the core module that caught it (`logger.child("<module>")`,
  `NoopLogger` by default), with `deviceId`, `step`, `error`, and the lease or
  requester where the site knows one. A failure whose error already travels on
  an event (`device.purge-failed`, `device.recovery-failed`,
  `device.quarantine-stranded`) is not logged again.
- **At `log.level: debug`, one `process` line per device command**:
  `LoggingProcessRunner` wraps the daemon's one `ProcessRunner` and logs the
  command, arguments, exit code and duration when it settles — never `env`,
  `input`, or output. Below `debug` the runner is not wrapped at all.
- **A failing event subscriber**, through `logger.child("bus")`, as one JSON
  line with the event, `seq`, message and stack.
- Startup, socket claim/recovery, driver discovery, connection lifecycle,
  shutdown, and unexpected errors with their stacks.

`startDaemon` builds the production `Logger` (`JsonLinesLogger` over a
`NodeFileLogSink`) from `config.log` right after config loads, then hands
module-scoped children (`logger.child("server")`, `.child("connection-host")`,
`.child("driver-discovery")`) to each component so every line is attributable.
The sink tracks bytes written and rotates `daemon.log` to `daemon.log.1`
(replacing any previous generation) once `config.log.rotateBytes` is exceeded,
so growth is bounded and `simlock daemon logs` reads the rotated generation
before the current file. `daemon logs --follow` (`src/cli/follow-log.ts`) polls
through the `Filesystem` and `Clock` ports every 250 ms, reading from a byte
offset (`readFileFrom`). It detects a rotation from `daemon.log.1` changing
identity (`FileStat.identity`), not from the current file shrinking, because a
fresh file can outgrow the old offset within one poll; it then prints the rest
of the rotated file and restarts at offset 0. Two rotations inside one poll lose
the middle generation, which the sink has already deleted. The one exception
is the fatal top-level handler: it
cannot depend on `config.log` having loaded successfully, so it builds its own
logger straight from the default log path at a fixed level, falling back to
`console.error` only if that itself fails.

Business facts live in the bus's two records. The ring buffer
(`eventBuffer.capacity`) holds recent events in memory and resets on restart.
`EventHistory` (`src/bus/event-file.ts`) subscribes to every event and writes
each envelope as one JSON line to `events.jsonl` in the data directory,
through a second `NodeFileLogSink` that `startDaemon` opens right after the
bus with `config.eventLog.rotateBytes`. That file is the durable record and
the audit trail: it survives restarts and crashes, rotates independently of
`daemon.log`, and on a gateway holds the relayed fleet events too. A file
that cannot be opened, or a write that fails, costs the history and never the
daemon or the emitter: one error line, writing stops, and replay falls back
to the ring. `events.replay` in both dispatchers asks `EventHistory`: without
`sinceTs` it answers from the ring, with `sinceTs` from the file (current
file, then its rotated generation, deduplicated by `id`).
The CLI reads the file itself only for `simlock events --since` when no
daemon answers; `--follow` subscribes first, replays, and drops replayed
pushes, so the join neither loses nor repeats an event.

## Device requests

Required to identify a device: **platform + device model + OS version**.
OS defaults to the newest runtime already installed on the machine that can
actually run the requested model — for iOS specifically, the newest
installed runtime that both falls inside the device type's supported range
(`simctl list devicetypes`' `minRuntimeVersion`/`maxRuntimeVersion`) and
still lists the model in its `supportedDeviceTypes`, not the newest
installed runtime overall (a newer runtime can drop a model, as iOS 26 did
for iPhone XS/XR). This still resolves on a fresh Xcode install with zero
simulator runtimes present at all — an empty runtime list is a normal
starting state, not a malformed catalog, so it falls straight through to
the same "not installed, permitted to download" path as a non-empty catalog
that simply lacks a matching runtime. If the requested runtime / system
image is not installed, the lease fails with a clear error unless downloads
are permitted for that request (downloads are multi-GB and must never be
triggered implicitly). An OS version outside a model's supported range
fails immediately with the range named in the error — never as an attempted
download, since no download could make it work.

Permission comes from `config.downloads.policy`, resolved once, in the
daemon, before a request ever reaches the acquisition path: `"never"`
forbids installs outright, even over an explicit `--allow-download` /
`allowDownload`; `"always"` grants it to every explicit lease request
without the caller having to ask; `"on-request"` (the default) defers to
the request's own flag, which is today's behavior byte-for-byte. Only an
explicit lease request (`LeaseEngine#request`) carries download permission,
and the acquisition coordinator, not a driver, acts on it by calling the
component installer (see "Components: one installer in the core"); no
`resolveSpec` downloads anything. Warm-pool provisioning and startup
convergence reuse specs already committed to the registry and never reach
the installer, so neither can trigger a download regardless of policy.

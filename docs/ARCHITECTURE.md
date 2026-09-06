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
  [CLIENT.md](CLIENT.md)) and the unix socket; the CLI is the full operator
  interface, and the MCP server intentionally limits its tool surface to
  leasing and releasing for an agent session. The HTTP frontend is different in
  kind, not just transport: it is the one frontend meant to be reached over a
  real network, so it calls the daemon's dispatcher **in-process** — the exact
  same one the socket path calls — rather than going through the unix socket at
  all, and requires a bearer token on every route but `GET /v1/healthz`. It
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
  [HTTP-API.md](HTTP-API.md) for the full route reference.
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
Two changes have moved it since. ADR 0004 removed `lease.heartbeat` and
`mode` from the contract with no shim behind them, taking the wire to
protocol 4; ADR 0005 adds `device.exec` and its `output` push family, again
with no compatibility path kept, taking it to 5. So the range both sides
advertise is `{min: 5, max: 5}`, an older client and a current daemon simply
do not overlap, and `hello` fails with `PROTOCOL_VERSION_UNSUPPORTED` naming
both ranges. The same negotiation runs over a worker's uplink, which is why a
worker older than ADR 0005 shows up in a gateway's views as `incompatible`
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
   `wss://` — or plain `ws://`/`http://` only over loopback or inside the
   operator's own tunnel, the same rule the HTTP API already states for
   itself and for the same reason: Simlock terminates no TLS in v1.

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

See [CLIENT.md](CLIENT.md) for how `simlock/client`/`simlock/admin` expose
`credential` and role at connect time, [CLI.md](CLI.md#admin-credential-resolution)
for the CLI's own walkthrough of the same resolution order, and
[HTTP-API.md](HTTP-API.md#authentication) for how HTTP's bearer-token roles
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
id, `label`, daemon health and version, negotiated protocol range, capacity
per platform, queue depth, leases, devices, catalog, effective download
policy, and drain state. On connect the gateway calls `status.get`,
`list.get`, `catalog.get`, `config.get`, and `events.subscribe` on the worker
and builds the view from the answers; it refreshes status and list on every
worker event that changes capacity or leases, and on a slow periodic tick as
a backstop.

`config.get` is the one of those read **once per connect** rather than on the
refresh path: config is daemon input, read at start, so a worker whose
`downloads.policy` changed has already restarted and reconnected. It is an
admin operation, which the uplink session is. The gateway keeps exactly one
field out of it — the effective `downloads.policy` — because routing has to
know whether a worker is even *allowed* to install a missing runtime before
it sends that worker a request which depends on one. It is a routing input
and never an override: the worker still clamps `allowDownload` through its
own policy, whatever the view said.

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
  the request waits, no worse off than before. A failure *after* work has
  begun is the request's own terminal failure, not a return to the queue;
- a request no worker can serve right now is **passed over, not blocked on**,
  so an Android request behind an iOS one proceeds the moment Android
  capacity frees.

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
The v1 policy (`warm-then-free`), in order:

1. drop workers that are disconnected, drained, incompatible, or lacking the
   requested platform, model, or runtime — a download counts as available
   only on a worker whose own `downloads.policy` would allow it;
2. prefer a worker with an unleased `ready` device matching the request — a
   **warm hit**, and a sub-second grant;
3. otherwise the worker with the **most free running capacity** for that
   platform.

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
annotated with the workers that have it.

Worker business events are republished on the gateway's bus with `workerId`
added to the payload and land in the gateway's own ring buffer, so `simlock
events --follow` against a gateway shows the whole fleet. The gateway also
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
  which is the `409 → GET` recovery loop the HTTP API already documents,
  applied across the uplink gap.
- **Gateway restart.** In-flight requests are lost, exactly as a worker
  restart loses them today (durable requests arrive with #72, for both).
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
  than by accident. That is the ordinary upgrade path, not a failure mode:
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
      ↓                              ↓
      └──────────→ quarantined ←─────┘
                        ↓
                 ready/shutdown/deleted
```

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
failure (`reclaiming → quarantined`) and the stalled-transition timeout
(`provisioning → quarantined`, both owned by `QuarantineCoordinator`) are its
two entries. The latter fires from `simlock doctor`'s `stalled-transition`
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
  `sys.boot_completed == 1` AND (`init.svc.bootanim == "stopped"` OR unset).

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
- `StartupConverger` runs TTL-timer restoration, interrupted-reclaim
  recovery, and running-capacity convergence in that order. `NukeService`
  coordinates lease release, pending-request cancellation, and
  registry-scoped reset operations.

The serialized decision gate protects only short read-decide-commit sections.
Driver work remains outside it. Component boundaries use direct calls for
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
`onDiagnostic` callback option instead — the Android driver already did this
for `snapshot-cold-boot` and unreadable device-profile sources; the iOS
driver gained the same option for component installs. `src/daemon/main.ts`
wires each driver's `onDiagnostic` at construction time
(`discoverDrivers`), bridging the diagnostic to `component.install-started` /
`component.installed` / `component.install-failed` — see
[EVENTS.md](EVENTS.md#components). This is also why those events are
attributed to the `driver-diagnostics` emitter rather than to `IosSimctlDriver`
or `AndroidDriver` directly: the driver only observed the fact, the daemon
layer is what committed it to the bus. Both drivers also thread the
requesting lease's `requesterId` (when `resolveSpec`'s caller knew one — see
`LeaseAcquisitionCoordinator#resolveAndDrive`) through the diagnostic into
the bridged event's payload, so a component install is attributable to the
request that caused it.

`component.installed` is a verified fact, not "the installer exited 0":
`xcodebuild`/`sdkmanager` reporting success only means the tool claims to
have finished, not that the thing the request actually needed — a runtime at
the requested version, paired with the requested device type for iOS; the
requested system image for Android — is now present. Both drivers re-scan
their own catalog (`simctl list` / the SDK's `system-images` tree) after the
installer returns and only report `component.installed` once that re-scan
confirms it; a re-scan that comes up empty reports `component.install-failed`
with that reason instead, and the caller still sees the same typed error it
always did (`DriverCrashError` for iOS's "still not installed" case,
`IosRuntimeUnpairedError` for a downloaded-but-unpaired runtime). Exactly one
terminal fact fires per install attempt, matching the pre-existing
`component.install-started` timing.

Before starting either install, the driver reserves free disk space against a
conservative per-component estimate (~8 GiB for an iOS runtime, ~2 GiB for an
Android system image) through a `DiskSpaceGuard` shared across every driver
(`src/daemon/main.ts` constructs one instance and passes it to each driver's
options) rather than a bare instantaneous `Filesystem#diskFree` reading: two
concurrent installs — an iOS runtime download racing an Android system-image
install, or two of either — could otherwise each observe enough free space
individually and jointly overfill the volume neither alone would have. The
guard tracks bytes reserved but not yet released, keyed per path, and checks
free space *minus* those outstanding reservations; the reservation is
released once the install settles either way. A reservation that doesn't fit
still fails fast with the same typed `InsufficientDiskSpaceError` naming
required vs. available bytes, and no `component.install-*` diagnostic fires
for a preflight failure, since no install was actually attempted.

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
SystemStats  — cpu count, total/free RAM, disk free
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

Operational logging is a separate concern from the event bus: `simlock events`
carries business facts (lease granted, device cleaned up, …) in an in-memory
ring buffer that resets on restart, while the `Logger` port writes durable,
structured JSON lines — one per record — for startup, socket claim/recovery,
driver discovery, connection lifecycle, shutdown, and unexpected/handled
errors. `startDaemon` builds the production `Logger` (`JsonLinesLogger` over a
`NodeFileLogSink`) from `config.log` right after config loads, then hands
module-scoped children (`logger.child("server")`, `.child("connection-host")`,
`.child("driver-discovery")`) to each component so every line is attributable.
The sink tracks bytes written and rotates `daemon.log` to `daemon.log.1`
(replacing any previous generation) once `config.log.rotateBytes` is exceeded,
so growth is bounded and `simlock daemon logs` reads the rotated generation
before the current file. The one exception is the fatal top-level handler: it
cannot depend on `config.log` having loaded successfully, so it builds its own
logger straight from the default log path at a fixed level, falling back to
`console.error` only if that itself fails.

`startDaemon` also subscribes `logger.child("components")` to `component.installed`
(`wireComponentInstallLogging` in `src/daemon/main.ts`) so a component simlock
installed on an agent's behalf stays attributable in `daemon.log` after the
event ring buffer resets on restart — the same durable-vs-ring-buffer split as
everything else in this section, applied to component installs specifically
because there is no registry entry or uninstall for them to be recovered from
otherwise (see "Out of scope" in the #67 issue). The log line carries
`requesterId` whenever the event payload has one, so the durable record names
which agent's request caused the install, not just that one happened.

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
explicit lease request (`LeaseEngine#request`) can carry download
permission to a driver's `resolveSpec` — warm-pool provisioning and startup
convergence reuse specs already committed to the registry and never call
`resolveSpec` themselves, so neither can trigger a download regardless of
policy.

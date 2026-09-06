# 0005. Gateway and worker modes

- **Status:** Accepted — not yet implemented
- **Date:** 2026-09-05
- **Issue:** [#115](https://github.com/callstackincubator/simlock/issues/115)
  (sub-issues #116–#120, one per sequenced PR)
- **Supersedes:** nothing
- **Depends on:** [ADR 0004](0004-ttl-first-leases-on-every-transport.md)

> This record is a PRD and an ADR in one file: the first half says what the
> feature is and who it is for, the second half records the shape it takes
> and why. Nothing is left open: the documentation now describes the decided
> end state, and the code catches up in the PRs sequenced under
> [Consequences](#consequences).

## Summary

Simlock gains a second run mode. A **worker** is what every simlock daemon is
today: it owns the devices on one machine. A **gateway** owns no devices at
all. Workers connect *to* it; it keeps a live picture of each one (health,
capacity, queue, leases, devices, catalog), holds one fleet-wide queue of
lease requests, dispatches each to the worker best placed to serve it,
proxies device commands to the worker that owns the device, and is the one
address the outside world — agents, the web console, agent-device — talks
to. To a client, a gateway looks like a single, larger simlock.

## Problem

Simlock coordinates agents on **one** machine. A team that owns several Macs
(each with its own simlock daemon) has to hand each agent a specific host,
watch each host separately, and rebalance by hand when one fills up while
another sits idle. `docs/IDEAS.md` records "cross-machine coordination" as
deliberately out of scope for v1; the HTTP API (`docs/HTTP-API.md`, "Not
implemented") reserved room for "multi-host brokering" without designing it.
The web console (#88) is explicitly one console per daemon for the same
reason. All three are waiting on this decision.

## Goal

An operator points agents and the console at one URL and stops caring which
machine a device lives on. Adding a machine means starting a worker on it
with the gateway's URL and a join token. Nothing an agent already does
against a single simlock has to change.

## Users

- **Agent (remote).** Requests a lease from the gateway over HTTP or MCP,
  gets a device somewhere in the fleet, drives it with `simctl`/`adb`
  commands, renews and releases it — all through the same URL. Never needs
  a worker's address.
- **Operator.** Mints join tokens, drains a worker for maintenance, sees
  every machine's health, capacity, queue, and leases in one `simlock status`
  and one console.
- **Machine owner running a worker.** Keeps using their local simlock
  exactly as today, plus two config keys that point it at a gateway. Workers
  behind NAT need no inbound port.

## Non-goals

- **A new API between gateway and worker.** The worker link carries the
  existing daemon contract (ADR 0003); the gateway calls the same operations
  a local admin CLI would.
- **A byte-heavy data plane.** Device *commands* (`simctl`, `adb`, their
  output) are proxied through the gateway; live screen streaming, port
  forwarding, and interactive TTYs are not. `dataPlane` on the lease object
  stays reserved for that.
- **File transfer.** A command that names a file (`simctl install
  <path>`, `adb install <apk>`) runs on the worker's filesystem; getting the
  file there is out of scope for v1 (see requirement 19b').
- **A gateway that also owns devices.** One process, one mode. A machine
  that should do both runs two daemons.
- **Durable gateway queue.** Pending requests on the gateway are in-memory,
  exactly as on a worker today; durability arrives with #72 on both.
- **Building the multi-worker console.** #88 stays its own PRD; this record
  only adds what the console needs to show many workers.
- **Worker auto-discovery** (mDNS, cloud tags). A worker knows its gateway;
  that is the discovery.

## Vocabulary

| Term | Meaning |
|---|---|
| worker | A simlock daemon in today's mode: drivers, registry, capacity, leases. `mode: "worker"`, the default. May optionally connect to a gateway. |
| gateway | A simlock daemon with no drivers and no device registry, fronting the workers connected to it. `mode: "gateway"`. |
| uplink | The one outbound WebSocket a worker keeps open to its gateway. The worker dials; over it, the gateway is the protocol client. |
| join token | A gateway-minted token with role `worker`, presented by a worker when opening its uplink. |
| worker view | What the gateway currently knows about one connected worker: id, label, daemon health and version, capacity per platform, queue depth, leases, devices, catalog, drain state. Rebuilt over the uplink, never persisted. |

"Host" is deliberately not used for the gateway: agent-device already calls
its own supervising process the Host (#70), and the docs use "host" for the
physical machine.

## Requirements

### Modes

1. `config.mode` selects `worker` (default) or `gateway`. One daemon runs
   exactly one mode; `simlock daemon start` starts whichever is configured.
2. A gateway starts no drivers, validates no device roots, and runs no
   reaper, health monitor, or capacity strategy. Of the existing config it
   reads only `http.*`, `log.*`, `lease.*`, and `eventBuffer.*`; worker-only
   keys in a gateway's config are ignored with a warning, as unknown keys are
   today. A gateway always listens on HTTP (it is the fleet's contact point)
   and on its unix socket (so the local CLI works against it). `http.enabled`
   is therefore not optional in this mode: `mode: "gateway"` with
   `http.enabled: false` is rejected at load and the daemon does not start,
   naming the key. A gateway nothing can reach has no safe reading — no
   worker could open an uplink to it and no agent could lease through it —
   so it fails rather than warns, the way a contradictory `lease.*` pair
   already does.
3. A worker joins a fleet with two keys: `gateway.url` and `gateway.token`
   (a join token), plus an optional `gateway.label` shown in views and on
   the lease. Nothing else on the worker changes; `http.enabled` is not
   required for a worker. `gateway.url` is the gateway's base URL, from
   which the worker derives the uplink endpoint (requirement 4); it should
   be `wss://`, or plain `ws://`/`http://` only over loopback or inside the
   operator's own tunnel, since Simlock terminates no TLS in v1. The two
   keys are a pair: **in `mode: "worker"`, one without the other is
   rejected at load** and the daemon does not start, because a
   half-configured uplink would otherwise come up looking like an ordinary
   standalone worker. In `mode: "gateway"` both are worker-side keys and are
   warned about and ignored like the rest (requirement 2).
3a. A worker's fleet id is its existing instance identity
   (`${SIMLOCK_HOME}/instance.json`): stable across restarts, unique by
   construction, opaque to clients. Two daemons on one machine have two
   `SIMLOCK_HOME`s and therefore two ids. `label` is display-only and need
   not be unique.

### The uplink

4. On start, and again after any disconnect with exponential backoff, a
   worker opens one WebSocket to **`<gateway.url>/v1/uplink`** (an ordinary
   HTTP upgrade), presenting its join token as an `Authorization` bearer and
   its instance id (`instance.json`). The gateway verifies the token against
   its token store. The two ways that can fail are different facts and get
   different answers, as everywhere else in the API: a **missing or
   unrecognized token is `401`**, and a **valid token whose role is not
   `worker` is `403`**. Either way nothing enters the worker registry and
   the gateway emits `worker.rejected` (requirement 22), which is the only
   trace an uplink refused at the door leaves.
5. Over the uplink the **gateway is the protocol client**: it sends `hello`
   and issues contract operations to the worker's own dispatcher, exactly as
   a local admin CLI would over the unix socket. The worker grants that
   session the `admin` role because it opened the connection to the gateway
   named in its own config — the credential in this handshake is the join
   token the worker presented, checked by the gateway, and the trust runs
   from the worker's configuration, never from the transport (ADR 0003 §5).

   This is a **third admin path**, alongside ADR 0003 §5's operator token
   and per-start admin secret, and it is the first one reached from the
   outside in. Its scope is worth stating plainly rather than deriving:
   **joining a fleet grants that gateway admin over the daemon that
   joined.** That is not a side effect to be narrowed later — a gateway has
   to `lease.request`, `lease.release`, `list.get`, `config.get`, and
   `events.subscribe` on its workers, which is exactly what an admin CLI
   does. Point a worker only at a gateway you would hand an operator token
   to. And because the join token is a bearer credential on the upgrade
   request, anything that can read that request can replay it, which is why
   requirement 3 puts `gateway.url` on `wss://` or inside the operator's own
   tunnel.
6. The uplink is the reachability signal. A worker whose uplink is open is
   `connected`; a worker whose uplink is closed is `disconnected` and stays
   in the gateway's views (with its last-known state, greyed) until the
   operator removes it or `gateway.disconnectedRetentionMs` (default 24
   hours) elapses — never while the gateway still knows of gateway-issued
   leases on it, since forgetting a worker that holds someone's device is
   how a lease becomes unroutable. That hold is **bounded by a TTL, not
   open-ended: it ends when the last of those leases passes its deadline**,
   because a lease nobody can renew is one the worker has already expired on
   its own clock. No polling is needed to detect loss.
7. On connect the gateway calls `status.get`, `list.get`, `catalog.get`,
   `config.get`, and `events.subscribe` on the worker. It refreshes status
   and list on every worker event that changes capacity or leases, and on a
   slow periodic tick as a backstop. `config.get` is read **once per
   connect** and not on the refresh path — config is daemon input, read at
   start, so a worker whose configuration changed has restarted and
   reconnected anyway — and the gateway keeps exactly one field out of it:
   the worker's effective `downloads.policy`, which the view carries and
   routing (requirement 13) needs in order to know whether a worker may
   install a missing runtime at all. It is a routing input, never an
   override: the worker still clamps `allowDownload` through its own policy.

### Worker registry (gateway side)

8. `simlock worker list|drain|undrain|remove` are admin operations on the
   gateway. A worker appears by connecting; `remove` forgets a disconnected
   worker's view (a connected one is refused with `WORKER_CONNECTED`). Join
   tokens are minted with the existing `simlock token create --role worker`
   and revoked with `simlock token revoke`; revoking closes the uplink.
   Each answers with the resulting state — `{ workerId, drained: true }`,
   `{ workerId, drained: false }`, `{ workerId, removed: true }` — and they
   diverge deliberately on a worker id the gateway does not know: `drain`
   and `undrain` **fail** with a new closed code `UNKNOWN_WORKER`, because
   draining is an instruction about one specific machine and succeeding
   silently against a typo would hide it in exactly the moment an operator
   most needs to know the instruction landed; `remove` **succeeds** with
   `{ removed: false }`, because "forget this worker" is already true of one
   the gateway has already forgotten (the reading `token.revoke` gives an
   unknown token id). A worker has no workers of its own, so it implements
   none of these operations: on a worker they answer `UNKNOWN_REQUEST`, and
   the `/v1/workers*` routes are simply not registered there (`404`).
8a. The gateway keeps a **worker registry**: which workers it knows, and
   which of them an operator has drained. Unlike a worker *view*, which is
   an observation rebuilt on every connect and never persisted, the registry
   is the gateway's own record and **is** persisted — a small JSON file
   under the gateway's `SIMLOCK_HOME`, written with owner-only permissions
   like everything else Simlock keeps there. It is the only gateway state
   that survives a restart, and requirement 9 is why it has to.
9. A **drained** worker keeps its existing leases and receives no new
   dispatches. Draining is the operator's tool for taking a machine down
   without killing anyone's device. It is an operator's *intent* about a
   machine rather than something observed on one, so it lives in the
   persisted worker registry (requirement 8a) and **survives both a worker
   reconnect and a gateway restart**; only `undrain` ends it. Both halves
   matter: a machine taken out of rotation for maintenance must not rejoin
   it because its own daemon restarted, and must not rejoin because a
   process the operator never touched restarted either.

### The fleet queue

10. A lease request arriving at the gateway enters **one gateway-side FIFO
    queue**. `timeoutMs` (`QUEUE_TIMEOUT`), `noWait` (`NO_CAPACITY`), and
    `lease.cancel` are enforced on that queue, with the same codes and
    progress states a worker uses (`queued` with `queuePosition`).
11. **Dispatch** runs whenever the queue or any worker view changes. For
    each queued request, oldest first, the routing policy picks an eligible
    worker with free capacity; the gateway sends it `lease.request` with
    `noWait: true`. The request becomes `dispatched` on either of two
    signals from that worker — the grant itself, or the **first `progress`
    push** for it (`provisioning`, `booting`, `reclaiming`), since device
    work having started means the request is that worker's now. An
    **immediate `NO_CAPACITY` is the only answer that leaves it queued**: it
    means the view was stale, so the gateway refreshes that worker's view
    and the request waits. A failure after work has begun is the request's
    own terminal failure, not a return to the queue. A request no worker can
    serve right now is passed over, not blocked on, so an Android request
    behind an iOS one proceeds when only Android capacity is free.
12. **Worker queues never hold gateway traffic.** Because every dispatch is
    `noWait`, a worker either takes the request immediately or refuses it.
    Local agents on the worker machine keep using the worker's own queue;
    the two never contend for a queue slot, only for capacity, and the
    worker's capacity accounting is the single arbiter of that.
13. The v1 routing policy, over the current worker views:
    1. drop workers that are disconnected, drained, or lack the requested
       platform, model, or runtime (a download is considered only on a
       worker whose download policy allows it);
    2. prefer a worker with an unleased `ready` device matching the request
       (warm hit: sub-second grant);
    3. otherwise the worker with the most free running capacity for that
       platform.
    No other placement rule exists in v1: no requester affinity, no label
    selectors, no per-worker platform exclusions. `label` is display-only.
    Each of those is a future routing policy option, not a change to the
    request shape.
14. **One lease per requester is fleet-wide.** A requester holding a
    gateway-issued lease on any worker gets `REQUESTER_ALREADY_LEASED` from
    the gateway, naming the existing lease. The gateway enforces this from
    its own index of leases it issued, rebuilt from each worker's
    `lease.list` on uplink connect. It recognizes its own in that list by
    the requester prefix it stamps on everything it forwards —
    `gw:<its own instance id>:` (requirement 27) — which works because an
    instance id is stable across restarts. That one filter is what lets the
    index be rebuilt from a worker's leases alone, with nothing persisted
    about leases on the gateway and no ambiguity about which are its own,
    another gateway's, or the worker's local ones; `lease.release-all`
    (requirement 34) and the retention hold (requirement 6) use the same
    filter, which is what keeps them off leases this gateway did not issue.

### Lease lifecycle through the gateway

15. Leases are TTL-first on every transport (ADR 0004), so the gateway does
    no emulation: `lease.renew`, `lease.release`, and single-lease reads
    forward to the owning worker, and `expiresAt` reported to the client is
    the worker's. A client that stops renewing loses its lease on the
    worker's clock, gateway or no gateway. Both daemons have a `lease.*`
    block and both apply: the **gateway's** `lease.defaultTtlMs` fills in a
    request that names no `ttlMs` and its `lease.maxTtlMs` caps what its own
    clients may ask for, both before anything is dispatched, so a fleet
    lease's width is decided at the gateway — but what it dispatches is an
    ordinary `lease.request`, so a worker with a lower cap still refuses it.
    Keep a gateway's `lease.maxTtlMs` at or below every worker's, or
    requests the gateway accepts fail on whichever machine they land on.
16. A gateway lease id names its worker, so renew, release, and reads route
    without consulting any state of its own: it is the owning worker's id,
    then a `.`, then the worker's own lease id, and routing **splits on the
    first `.`** (a worker id is a UUID, so a real one reads
    `3f81a2c4-9b7d-4e21-8a55-1c0e6f2d7b93.lse_9f2c`; docs abbreviate it).
    The separator is path-safe because the id appears in
    `/v1/leases/{id}` routes. Clients treat the whole id as opaque.
17. The gateway keeps no per-connection lease state and releases nothing
    when a client connection closes, exactly as a worker (ADR 0004 §3). A
    gateway client that stops renewing loses its lease on the worker's
    clock.
18. The lease object gains `worker: { id, label }` (additive) so a client and
    the console can tell where the device lives. A worker's network address
    is never exposed: clients reach devices through the gateway (below).
19. Progress pushes for a dispatched request, and lease-scoped pushes
    (`lease-lost`, `device-unhealthy`, `device-recovered`) relayed by the
    worker's event stream, are re-pushed by the gateway to whichever of its
    connections owns the request or lease, exactly as a worker does today.

### Reaching a device

Today a lease holder reaches its device with `simlock simctl` / `simlock
adb`: the daemon resolves a root-scoped command (`driver.passthrough`) and
the CLI spawns it locally. That only works on the worker's own machine. A
remote agent — over HTTP today, through a gateway tomorrow — has no way to
drive the device it leased.

19a. New contract operation **`device.exec`** (role `agent`):
     `{ leaseId, tool: "simctl" | "adb", args, stdin?, requesterId? }`. The
     **worker** resolves the command through the same driver passthrough
     logic (same root scoping, same refusal list for verbs that would change
     a device's lifecycle behind the registry's back) and runs it through
     its `ProcessRunner`. A refused verb reuses the existing
     `PASSTHROUGH_REFUSED`, and a `tool` outside the wrapped set the
     existing `UNKNOWN_PASSTHROUGH_TOOL` — the codes `driver.passthrough`
     already answers with, at the status and exit code they already carry
     (`422` / exit 2). The list gains exactly one entry this operation needs
     and the local passthrough does not: **a bare `adb shell` with no
     command is refused** ("needs a terminal"), because there is no
     pseudo-terminal to attach it to and accepting it would only stall until
     the timeout. Output streams back as request-scoped pushes (`output`,
     carrying `stream: "stdout" | "stderr"` and a chunk, keyed by the frame
     id like `progress`); chunks are UTF-8 text, so a command whose output
     is binary should write a file on the worker instead. The operation
     resolves with `{ exitCode }` — the tool's own, so a non-zero one is the
     command's answer and not an API failure. `stdin` is a **single string
     sent with the request** and written to the process, which is then
     closed; there is no incremental stdin channel. It is a contract
     operation, so it works on the unix socket, over HTTP
     (`POST /v1/leases/{id}/exec`, response streamed as Server-Sent Events,
     the same shape `/events` already uses), and over the uplink.
19a'. **Ownership on `device.exec`, and the one place `admin` does not
     bypass.** A non-admin session is gated the ordinary way — its principal
     against the lease's `ownerId`, exactly as `lease.renew` and
     `lease.release` are (ADR 0003 §4) — and needs no `requesterId` at all.
     The optional `requesterId` (defaulting to the principal, and namable
     only by an admin session) exists for the one session that would
     otherwise bypass that check: the gateway's admin session on a worker.
     There, unlike renew and release, **admin does not bypass** — the worker
     compares the supplied `requesterId` to the lease's own and answers
     `FORBIDDEN` on a mismatch. Without that second check, "the gateway
     checked its own lease index" would be the only thing standing between
     one fleet agent and another agent's device.
19b. The **gateway proxies** `device.exec` to the owning worker over its
     uplink and relays the output pushes to the calling connection,
     unchanged. It parses nothing about the command; ownership is checked
     twice, once per hop — at the gateway against its own lease index, and
     again at the worker, which compares the forwarded namespaced requester
     to the lease in front of it (19a').
19b'. `device.exec` runs against the worker's filesystem. Getting an
     artifact there (an `.app`, an `.apk`) is out of scope for v1; it
     arrives out of band (a shared volume, a CI checkout on the worker). The
     seam for a later `device.upload` — chunks streamed as request-scoped
     pushes over the same wire into a per-lease scratch directory deleted
     on release — is left open by design, not built.
19c. The CLI's `simlock simctl` / `simlock adb` keep spawning locally with
     inherited stdio when they talk to a worker over its unix socket (an
     interactive `adb shell` keeps working there). Against a gateway they
     use `device.exec` and print the streamed output, exiting with the
     tool's own status; a piped stdin is read to EOF first and sent as
     19a's one-shot string. There is no pseudo-terminal either way, so
     line-oriented commands work and full-screen ones do not. `device.exec`
     is scoped to a lease, so these commands need one: the caller's own by
     default, which one-lease-per-requester makes unambiguous, or
     `--lease <id>` to name it. Two details the CLI does not get to decide
     for itself:
     - **It switches on `mode` from `status.get`**, which it already calls:
       `gateway` means `device.exec`, anything else means
       `driver.passthrough`. Not a flag, not a guess — the daemon says what
       it is. (The CLI speaks the unix socket only; a remote agent reaches
       the same operation over the HTTP API.)
     - **It holds no copy of the refusal list**, in either direction.
       Frontends render the contract and the list lives with the driver that
       owns the device (ADR 0003 §11), so the daemon refuses and the CLI
       relabels: `driver.passthrough`'s refusal locally, `device.exec`'s
       `PASSTHROUGH_REFUSED` / `UNKNOWN_PASSTHROUGH_TOOL` through a gateway,
       both surfacing as the `USAGE` exit 2 the local path already produces.
       A caller reaching `device.exec` over HTTP gets the daemon's own code,
       unrelabelled.
19d. `driver.passthrough` answers `UNSUPPORTED_IN_GATEWAY_MODE` on a
     gateway: a root-scoped command string naming a device set on another
     machine is something the client cannot run, and handing it one would be
     worse than an error. That answer is permanent rather than provisional —
     see requirement 34 — which is why `501` is the honest HTTP status for
     it and not a temporary condition to retry past.
19e. Limits: one per-command timeout per hop. **`exec.timeoutMs` on the
     worker (ten minutes) is authoritative**, because that side owns the
     process and is the only one that can kill it;
     **`gateway.execTimeoutMs` (eleven minutes) is a backstop** for the case
     where the worker never answers at all. The gateway's is deliberately
     the longer of the two: equal defaults would make the worker's authority
     a coin toss on every timeout, where the point is that an ordinary
     timeout surfaces as the worker's own `EXEC_TIMEOUT` rather than racing
     the gateway's. `EXEC_TIMEOUT` is CLI exit 10 and HTTP `504` — though on
     `POST /v1/leases/{id}/exec` the status never reaches the client, since
     the response is already `200` and streaming by the time a command can
     time out, so it arrives as that stream's terminal `error` event; the
     status is for a client mapping the code without a route in front of it.
     Output is streamed, never buffered, so there is no size cap. No
     concurrency cap per lease beyond what the tool itself tolerates.

### Status, events, catalog

20. `status.get` on a gateway returns the same shape a worker returns —
    capacity summed across connected workers, all gateway-issued and local
    leases, all devices, the gateway queue's depth — plus an additive
    `workers` array with one entry per worker view. Every device and lease in
    the aggregate carries `workerId`.
21. `catalog.get` on a gateway is the union of worker catalogs, each model
    and runtime annotated with the workers that have it.
22. Worker business events are republished on the gateway's bus with
    `workerId` added to the payload and land in the gateway's own ring
    buffer, so `simlock events --follow` against a gateway shows the fleet.
    The gateway emits its own facts: `worker.connected`,
    `worker.disconnected`, `worker.rejected`, `worker.removed`,
    `worker.drain-started`, `worker.drain-ended`, `request.dispatched`
    (documented in `EVENTS.md` in the same change).
    `worker.rejected` covers an uplink refused at the door (requirement 4):
    payload `{ reason, workerId?, label?, protocol? }` with `reason` either
    `unauthenticated` (`401`) or `forbidden` (`403`), everything else
    optional because a dial that fails authentication proves no identity.
    Without it a refused uplink leaves no trace at all, and "why did that
    machine never appear" is exactly what an operator comes to the event
    stream to answer. `device.exec` deliberately emits **no** event: running
    a command is not a state change Simlock owns, the lease authorizing it
    already emitted `lease.granted`, and one event per `adb shell input tap`
    would empty the ring buffer of everything else.
23. New admin operation `worker.list` and HTTP route `GET /v1/workers` return
    the worker views; `worker.drain|undrain|remove` map to
    `POST /v1/workers/{id}/drain`, `DELETE /v1/workers/{id}/drain`,
    `DELETE /v1/workers/{id}`. These are what the console (#88) renders.

### Authentication

24. Client → gateway: the gateway has its own token store and mints its own
    `agent` and `operator` tokens with `simlock token`, exactly as a worker
    does. A gateway token is never valid on a worker and vice versa.
25. Worker → gateway: the join token (role `worker`). `/v1/uplink`
    (requirement 4) is the one route it opens and the only route it opens:
    presented on any **other** `/v1` route it is `403`, and an
    `agent`- or `operator`-role token presented at `/v1/uplink` is `403`
    just the same. The role is disjoint from the other two rather than above
    or below them.
26. The gateway enforces per-requester ownership itself before forwarding
    anything on the uplink's admin session, so an agent token on the gateway
    can never reach another requester's lease through it.
27. The requester id the gateway forwards to a worker is namespaced
    (`gw:<gateway instance id>:<requester>`) so a local agent on the worker
    machine and a remote one behind the gateway can never collide on the
    one-lease rule or on attribution.

### Failure behaviour

28. **Uplink down.** No new dispatches to that worker. A renew or release for
    a lease on it fails with a new closed error code `WORKER_UNREACHABLE`
    (`kind: "transport"`, CLI exit 1, HTTP `503` — where every other
    `transport`-kind code in the contract's table already sits, since "the
    thing behind this is not reachable right now" is the same answer in all
    of them); the worker's own TTL eventually expires the lease
    and reclaims the device, and the gateway relays `lease-lost` once the
    uplink returns and it sees the worker's `lease.expired` fact. The
    gateway never guesses a lease is gone before the worker says so.
29. **Request dispatched, then uplink lost.** The request's client sees it
    fail with `WORKER_UNREACHABLE`; if the worker actually granted it, the
    lease exists on the worker and expires there on its TTL. The client's
    retry hits the fleet-wide one-lease rule only once the uplink is back
    and the index is rebuilt — the same `409 → GET` recovery loop the HTTP
    API already documents, applied across the uplink gap.
30. **Gateway restart.** In-flight requests are lost, exactly as a worker
    restart loses them today. Leases survive on workers; workers reconnect
    on their backoff and the gateway rebuilds every view and its lease index
    from them — picking its own leases out of each `lease.list` by the
    `gw:<its own instance id>:` prefix (requirement 14), which is what makes
    a rebuild possible with nothing about leases persisted. The worker
    registry (requirement 8a) comes back off disk instead of being
    re-derived, so drains survive. Gateway clients keep their leases and
    simply resume renewing once the gateway answers again.
31. **Version skew.** `hello` over the uplink negotiates the protocol range
    exactly as over the socket (ADR 0003 §6). A worker outside the gateway's
    range is marked `incompatible` in its view, with both ranges, and is
    never dispatched to. That uplink **authenticated**, so this is not a
    `worker.rejected` (requirement 22): the worker enters the registry and
    is visible in `simlock worker list` — which is the point, since it is
    the machine an operator has to go and upgrade — while no
    `worker.connected` follows, because nothing usable connected. It keeps
    serving its own local clients on its own protocol meanwhile. Since this
    record takes the wire to protocol 5 with no shim (see Consequences),
    every worker older than it is `incompatible` by range: the ordinary
    upgrade path, not a failure mode.

### Engineering

32. The gateway is a second implementation of the daemon contract's
    handlers (ADR 0003 §2), not a second contract: `src/gateway/` provides
    a `Dispatcher` whose handlers read worker views and forward over
    uplinks instead of calling `core`. Every existing frontend — CLI, MCP,
    HTTP, `simlock/client` — works against a gateway with no frontend
    change, because they only ever see the contract.
33. `src/gateway/` imports nothing from `drivers`, and from `core` only the
    platform-agnostic queue and bus modules it reuses; never the registry,
    capacity, or lifecycle modules (enforced like
    `src/contract/boundary.test.ts`). The uplink is a port
    (`UplinkListenerFactory` on the gateway, `UplinkConnector` on the
    worker) with a WebSocket adapter, so tests script it in memory.
34. Operations that act on a machine's devices as a whole — `nuke.run`,
    `cleanup.run`, `doctor.run` — and `driver.passthrough` answer
    `UNSUPPORTED_IN_GATEWAY_MODE` in v1; they stay per-worker, direct
    operations, permanently rather than pending a later fan-out.
    `config.get` returns the gateway's own config.
    `lease.release-all` is the one operation in this family that a gateway
    *does* implement, because it is scoped to leases rather than to a
    machine's devices: it releases **only the leases that gateway issued**
    (requirement 14's prefix filter), across every connected worker, and
    never a worker's own local leases — the gateway did not issue those,
    does not know who holds them, and taking a local developer's device away
    from an endpoint they have never heard of is not an operator action
    anyone asked for. A worker it cannot reach is reported as
    `WORKER_UNREACHABLE` naming that worker while the reachable ones still
    complete: a partial result stated plainly beats an all-or-nothing that
    leaves the operator guessing.
35. Tests: one suite per gateway handler against scripted uplinks and a
    manually-advanced `Clock` (dispatch order and pass-over, stale-view
    `NO_CAPACITY`, drained and disconnected workers, fleet-wide one-lease
    rule, lease id routing, reconnect rebuild). One
    e2e test starts two fake-driver workers and a gateway in one process
    tree and leases through the gateway.

## Decision

1. **Workers dial out; the gateway never needs to reach a worker.** The
   only inbound port in the fleet is the gateway's. A worker behind NAT, on
   a laptop, or on a CI runner joins with a URL and a token.
2. **The uplink carries the existing contract, with the gateway as the
   protocol client.** No second API, no second vocabulary: what the gateway
   can do to a worker is exactly what an admin CLI can, and every operation
   added to the contract is available over the uplink for free.
3. **The gateway implements the contract towards its own clients.** Anything
   that can talk to a simlock daemon can talk to a gateway. The console,
   agent-device, MCP, and the CLI get fleet support with no change.
4. **One fleet queue, dispatched with `noWait`.** The gateway owns demand;
   workers own capacity. A request is never parked in a worker queue, so it
   can be granted by whichever worker frees first, and the worker's capacity
   accounting stays the single arbiter between gateway and local agents.
5. **Leases need no gateway state.** TTL-first leases (ADR 0004) make renew
   a forwarded operation and the lease id the only routing key. A gateway
   restart loses nothing a worker restart would not also lose. The one thing
   a gateway does persist is the worker registry (requirement 8a) — which
   workers it knows and which are drained — because drain is an operator's
   intent and not an observation; nothing about a *lease* is written there.
6. **Capacity and safety stay on the worker.** The gateway never touches a
   device, so every rule in `docs/agent-rules/safety.md` keeps holding by
   construction: registry-only destruction, never touching a leased device,
   no implicit downloads (the gateway forwards `allowDownload` and the worker
   clamps it through its own policy).
7. **Routing is a pure function over worker views**, a module with one entry
   point selected by `gateway.routing`, the same shape as `CapacityStrategy`.
   Nothing else in the gateway knows how a worker is chosen.
8. **Device commands execute on the worker and travel over the contract.**
   The gateway is a proxy for them, over the same uplink it uses for
   everything else. No worker address ever reaches a client, no second
   network path exists, and a remote HTTP agent gets the same ability
   against a lone worker without a gateway at all — which closes the gap
   that left `dataPlane` reserved (#66).
9. **A joined worker keeps serving its local clients.** Local agents and the
   gateway share the worker's capacity; the worker's own accounting
   arbitrates, and the gateway's views show local leases too.

## Consequences

- The contract gains: `mode` in `status.get`'s daemon block, `workerId` on
  devices and leases, `worker` on the lease object, `workers` on status,
  `worker.*` operations, `device.exec` with its `output` push family, the
  `worker` token role, and five error codes. All additive.
- **The five new error codes, with the columns the contract's table already
  has for every other code** (`kind`, `cliExitCode`, `httpStatus`):
  `WORKER_UNREACHABLE` (`transport`, exit 1, `503`, requirement 28);
  `WORKER_CONNECTED` (`domain`, exit 2, `409`, requirement 8);
  `UNKNOWN_WORKER` (`domain`, exit 12, `404`, requirement 8);
  `UNSUPPORTED_IN_GATEWAY_MODE` (`domain`, exit 2, `501`, permanent rather
  than provisional, requirements 19d and 34); `EXEC_TIMEOUT` (`domain`,
  exit 10, `504`, requirement 19e). `device.exec`'s refusals add no code at
  all: they reuse `PASSTHROUGH_REFUSED` and `UNKNOWN_PASSTHROUGH_TOOL`
  (requirement 19a), which already carry exit 2 and `422`.
- **The socket wire moves to protocol 5 with no compatibility shim**, so
  both sides advertise `{min: 5, max: 5}`: `device.exec` and its `output`
  push family are new frames and no compatibility path is kept for them, and
  under ADR 0003 §6's honesty rule a range widens only where one is. This is
  the same wire ADR 0004 took to 4, so what ships carries both moves at
  once. Over the uplink it is ordinary negotiation (requirement 31).
- New config: `mode`, `gateway.url`, `gateway.token`, `gateway.label`,
  `exec.timeoutMs` (worker side, ten minutes and authoritative);
  `gateway.routing`, `gateway.disconnectedRetentionMs` (24 hours),
  `gateway.execTimeoutMs` (gateway side, eleven minutes — a backstop
  deliberately longer than the worker's, requirement 19e). Two pairs are
  rejected at load rather than warned about, because neither has a safe
  reading: `mode: "gateway"` with `http.enabled: false` (requirement 2), and
  in `mode: "worker"` one of `gateway.url`/`gateway.token` without the other
  (requirement 3).
- The two-Mac case runs two daemons on the machine that should do both: a
  worker and a gateway with distinct `SIMLOCK_HOME`s, the worker joining the
  gateway over localhost. What has to be kept apart is small, because only
  one of them owns anything: distinct `SIMLOCK_HOME`s (which is what gives
  them separate config, state, sockets, logs, token stores, and the distinct
  instance ids that make the worker its own fleet member); distinct
  `http.port`s if both listen, since a port is machine-global and
  `SIMLOCK_HOME` cannot isolate it; and only the gateway needing
  `http.enabled` at all, since the worker dials out. The worker keeps its
  whole `drivers.*` block — it owns the devices, the gateway has no drivers
  to configure — so unlike two *workers* on one machine there is no
  `drivers.android.adbServerPort` to split.
- `docs/HTTP-API.md` gains the `/v1/workers` routes and the uplink endpoint,
  and drops "multi-host brokering" from "Not implemented"; `docs/IDEAS.md`
  drops "Cross-machine coordination"; #88 drops its "one console per daemon"
  non-goal.
- Sequencing, one PR each, each leaving the tree working, after ADR 0004
  has landed:
  0. `device.exec` on the worker, with the CLI and HTTP frontends — useful
     on its own for remote HTTP agents, and the gateway proxies it later;
  1. `config.mode`, `src/gateway/` skeleton, the uplink ports and WebSocket
     adapters, `worker` token role, worker views, `worker.*` operations,
     aggregated `status.get`/`catalog.get`/`events.*`, `GET /v1/workers` —
     the fleet is visible before it is routable, which is what the console
     needs first;
  2. the fleet queue, routing policy, dispatch, `lease.request`/`renew`/
     `release`/`cancel`/`list` forwarding, fleet-wide one-lease rule, lease
     and progress pushes relayed;
  3. drain semantics, `WORKER_UNREACHABLE` paths, reconnect rebuild, e2e
     test;
  4. docs, changelog, and the #88 endpoints.

## Alternatives considered

- **Gateway polls workers by URL (pull).** Zero worker changes and a plain
  HTTP client, but every worker needs an inbound route from the gateway —
  a tunnel per Mac — which is the main operational pain this feature should
  remove. Rejected in favour of the uplink.
- **A registration API** (worker POSTs heartbeats, gateway calls the
  worker's `/v1` for leases). Half push, half pull; the lease path still
  needs the worker reachable. Rejected.
- **Per-worker queues only** (gateway forwards to the shortest worker
  queue). No gateway demand state, but a request parked on one worker
  cannot be granted by another that frees first, and gateway traffic
  competes with local agents for queue slots. Rejected in favour of the
  fleet queue.
- **Dispatching into worker queues and taking requests back** when another
  worker frees first. Two queues per request and a cancellation race.
  Rejected.
- **Workers reserve a capacity slice for the gateway.** Protects gateway
  traffic from local starvation, but adds a worker-side concept for a
  problem the views make visible anyway. Deferred.
- **Emulating held mode at the gateway.** Made unnecessary by ADR 0004.
- **Redirecting clients to the worker after the grant.** Makes every client
  fleet-aware and needs per-worker client credentials. Rejected: the gateway
  is the contact point, so it proxies the whole lease lifecycle.
- **Advertising a worker address on the lease** so clients drive the device
  directly. Needs every worker reachable from every client, which is the
  NAT problem the uplink removes, and reopens per-worker credentials.
  Rejected in favour of proxying `device.exec`.
- **Fanning `doctor.run` / `cleanup.run` out to every worker.** Useful for
  the console later; a fleet-wide destructive command from one endpoint is
  not something v1 should offer. Deferred; all four stay per-worker.
- **Naming the modes `host` / `worker`.** Rejected: agent-device already
  has a Host process (#70) and the docs use "host" for the machine.
- **A gateway that is also a worker (hybrid).** Every gateway code path
  would need a "local" special case and the gateway would hold device
  state. Rejected; run two daemons with distinct `SIMLOCK_HOME`s and
  distinct `http.port`s (see Consequences).

## Open questions

None outstanding for this record. Lease parameters are settled in ADR 0004.

# 0005. Gateway and worker modes

- **Status:** Proposed
- **Date:** 2026-09-05
- **Issue:** none yet
- **Supersedes:** nothing
- **Depends on:** [ADR 0004](0004-ttl-first-leases-on-every-transport.md)

> This record is a PRD and an ADR in one file: the first half says what the
> feature is and who it is for, the second half records the shape it takes
> and why. Everything under [Open questions](#open-questions) is still being
> decided; everything else is the current proposal.

## Summary

Simlock gains a second run mode. A **worker** is what every simlock daemon is
today: it owns the devices on one machine. A **gateway** owns no devices at
all. Workers connect *to* it; it keeps a live picture of each one (health,
capacity, queue, leases, devices, catalog), holds one fleet-wide queue of
lease requests, dispatches each to the worker best placed to serve it, and
is the one address the outside world — agents, the web console,
agent-device — talks to. To a client, a gateway looks like a single, larger
simlock.

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
  gets a device somewhere in the fleet, renews and releases it through the
  same URL. Never learns a worker's address unless it needs one to reach the
  device.
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
- **Proxying the data plane.** The gateway hands out leases; driving the
  device (adb, simctl, screen) still happens against the worker that owns it.
  `dataPlane` on the lease object stays reserved.
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
   and on its unix socket (so the local CLI works against it).
3. A worker joins a fleet with two keys: `gateway.url` and `gateway.token`
   (a join token), plus an optional `gateway.label` shown in views. Nothing
   else on the worker changes; `http.enabled` is not required for a worker.

### The uplink

4. On start, and again after any disconnect with exponential backoff, a
   worker opens one WebSocket to `gateway.url`, presenting its join token and
   its instance id (`instance.json`). The gateway verifies the token against
   its token store (role `worker`) and rejects anything else with `401`.
5. Over the uplink the **gateway is the protocol client**: it sends `hello`
   and issues contract operations to the worker's own dispatcher, exactly as
   a local admin CLI would over the unix socket. The worker grants that
   session the `admin` role because it opened the connection to the gateway
   named in its own config — the credential in this handshake is the join
   token the worker presented, checked by the gateway, and the trust runs
   from the worker's configuration, never from the transport (ADR 0003 §5).
6. The uplink is the reachability signal. A worker whose uplink is open is
   `connected`; a worker whose uplink is closed is `disconnected` and stays
   in the gateway's views (with its last-known state, greyed) until the
   operator removes it or a configurable retention elapses. No polling is
   needed to detect loss.
7. On connect the gateway calls `status.get`, `list.get`, `catalog.get`,
   and `events.subscribe` on the worker. It refreshes status and list on
   every worker event that changes capacity or leases, and on a slow
   periodic tick as a backstop.

### Worker registry (gateway side)

8. `simlock worker list|drain|undrain|remove` are admin operations on the
   gateway. A worker appears by connecting; `remove` forgets a disconnected
   worker's view (a connected one is refused with `WORKER_CONNECTED`). Join
   tokens are minted with the existing `simlock token create --role worker`
   and revoked with `simlock token revoke`; revoking closes the uplink.
9. A **drained** worker keeps its existing leases and receives no new
   dispatches. Draining is the operator's tool for taking a machine down
   without killing anyone's device.

### The fleet queue

10. A lease request arriving at the gateway enters **one gateway-side FIFO
    queue**. `timeoutMs` (`QUEUE_TIMEOUT`), `noWait` (`NO_CAPACITY`), and
    `lease.cancel` are enforced on that queue, with the same codes and
    progress states a worker uses (`queued` with `queuePosition`).
11. **Dispatch** runs whenever the queue or any worker view changes. For
    each queued request, oldest first, the routing policy picks an eligible
    worker with free capacity; the gateway sends it `lease.request` with
    `noWait: true`. A grant or a provisioning-in-progress answer moves the
    request to `dispatched`; `NO_CAPACITY` (a stale view) refreshes that
    worker's view and the request stays queued. A request no worker can
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
14. **One lease per requester is fleet-wide.** A requester holding a
    gateway-issued lease on any worker gets `REQUESTER_ALREADY_LEASED` from
    the gateway, naming the existing lease. The gateway enforces this from
    its own index of leases it issued, rebuilt from each worker's
    `lease.list` on uplink connect.

### Lease lifecycle through the gateway

15. Leases are TTL-first on every transport (ADR 0004), so the gateway does
    no emulation: `lease.renew`, `lease.release`, and single-lease reads
    forward to the owning worker, and `expiresAt` reported to the client is
    the worker's. A client that stops renewing loses its lease on the
    worker's clock, gateway or no gateway.
16. A gateway lease id names its worker, so renew, release, and reads route
    without consulting any state of its own. Clients treat the id as opaque.
17. `releaseOnDisconnect` (ADR 0004 §3) is honoured at the gateway for its
    own socket and WebSocket clients: when such a client's connection closes,
    the gateway releases the lease on the worker. Over HTTP the flag is
    ignored, as on a worker.
18. The lease object gains `worker: { id, label }` (additive) so a client and
    the console can tell where the device lives. The worker's network
    address is **not** on the lease; see open question 5.
19. Progress pushes for a dispatched request, and lease-scoped pushes
    (`lease-lost`, `device-unhealthy`, `device-recovered`) relayed by the
    worker's event stream, are re-pushed by the gateway to whichever of its
    connections owns the request or lease, exactly as a worker does today.

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
    `worker.disconnected`, `worker.removed`, `worker.drain-started`,
    `worker.drain-ended`, `request.dispatched` (documented in `EVENTS.md`
    in the same change).
23. New admin operation `worker.list` and HTTP route `GET /v1/workers` return
    the worker views; `worker.drain|undrain|remove` map to
    `POST /v1/workers/{id}/drain`, `DELETE /v1/workers/{id}/drain`,
    `DELETE /v1/workers/{id}`. These are what the console (#88) renders.

### Authentication

24. Client → gateway: the gateway has its own token store and mints its own
    `agent` and `operator` tokens with `simlock token`, exactly as a worker
    does. A gateway token is never valid on a worker and vice versa.
25. Worker → gateway: the join token (role `worker`). It can open an uplink
    and nothing else; a `worker`-role token presented on a `/v1` route is
    `403`.
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
    (`kind: "transport"`); the worker's own TTL eventually expires the lease
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
    from them. Gateway clients with `releaseOnDisconnect` leases lose them,
    as they would on a worker restart.
31. **Version skew.** `hello` over the uplink negotiates the protocol range
    exactly as over the socket (ADR 0003 §6). A worker outside the gateway's
    range is marked `incompatible` in its view, with both ranges, and is
    never dispatched to.

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
34. Operations that only make sense against real devices — `nuke.run`,
    `cleanup.run`, `doctor.run`, `driver.passthrough` — answer
    `UNSUPPORTED_IN_GATEWAY_MODE` in v1 (see open question 7).
    `config.get` returns the gateway's own config.
35. Tests: one suite per gateway handler against scripted uplinks and a
    manually-advanced `Clock` (dispatch order and pass-over, stale-view
    `NO_CAPACITY`, drained and disconnected workers, fleet-wide one-lease
    rule, lease id routing, `releaseOnDisconnect`, reconnect rebuild). One
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
   restart loses nothing a worker restart would not also lose.
6. **Capacity and safety stay on the worker.** The gateway never touches a
   device, so every rule in `docs/agent-rules/safety.md` keeps holding by
   construction: registry-only destruction, never touching a leased device,
   no implicit downloads (the gateway forwards `allowDownload` and the worker
   clamps it through its own policy).
7. **Routing is a pure function over worker views**, a module with one entry
   point selected by `gateway.routing`, the same shape as `CapacityStrategy`.
   Nothing else in the gateway knows how a worker is chosen.

## Consequences

- The contract gains: `mode` in `status.get`'s daemon block, `workerId` on
  devices and leases, `worker` on the lease object, `workers` on status,
  `worker.*` operations, the `worker` token role, and error codes
  `WORKER_UNREACHABLE`, `WORKER_CONNECTED`, `UNSUPPORTED_IN_GATEWAY_MODE`.
  All additive.
- New config: `mode`, `gateway.url`, `gateway.token`, `gateway.label`
  (worker side); `gateway.routing`, `gateway.disconnectedRetentionMs`
  (gateway side).
- `docs/HTTP-API.md` gains the `/v1/workers` routes and the uplink endpoint,
  and drops "multi-host brokering" from "Not implemented"; `docs/IDEAS.md`
  drops "Cross-machine coordination"; #88 drops its "one console per daemon"
  non-goal.
- Sequencing, one PR each, each leaving the tree working, after ADR 0004
  has landed:
  1. `config.mode`, `src/gateway/` skeleton, the uplink ports and WebSocket
     adapters, `worker` token role, worker views, `worker.*` operations,
     aggregated `status.get`/`catalog.get`/`events.*`, `GET /v1/workers` —
     the fleet is visible before it is routable, which is what the console
     needs first;
  2. the fleet queue, routing policy, dispatch, `lease.request`/`renew`/
     `release`/`cancel`/`list` forwarding, fleet-wide one-lease rule, lease
     and progress pushes relayed;
  3. drain semantics, `releaseOnDisconnect` at the gateway,
     `WORKER_UNREACHABLE` paths, reconnect rebuild, e2e test;
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
- **A gateway that is also a worker (hybrid).** Every gateway code path
  would need a "local" special case and the gateway would hold device
  state. Rejected; run two daemons with distinct `SIMLOCK_HOME`s.

## Open questions

Answers to these change the requirements above, not just the wording.

1. **Naming.** `gateway`/`worker` (proposed, avoids agent-device's "Host"),
   or `host`/`worker` as the original ask phrased it?
2. **Worker identity.** Instance id from `instance.json` (proposed, stable
   across restarts, opaque) or an operator-chosen id that must be unique?
3. **Disconnected retention.** How long does a disconnected worker stay in
   views before it is forgotten automatically? Proposal: 24 hours, and
   never while it still holds gateway-issued leases the gateway knows of.
4. **Routing constraints.** Any placement rule beyond capacity — pin a
   requester to a worker, prefer a worker by label (Xcode version, chip),
   or exclude a platform on a worker? Proposal: none in v1; `label` is
   display-only.
5. **Reaching the device.** Is `worker: { id, label }` on the lease enough,
   with the operator mapping label to address out of band, or should a
   worker advertise an `address` over the uplink that the gateway puts on
   the lease? The second is the first step towards a data plane.
6. **Hybrid.** Is "a gateway never owns devices" acceptable for the
   two-Mac case?
7. **Fan-out operations.** Should `doctor.run` and `cleanup.run` through the
   gateway fan out to every connected worker, with `workerId` on each
   finding or action, instead of `UNSUPPORTED_IN_GATEWAY_MODE`?
8. **Local agents versus the fleet.** Should a worker that has joined a
   gateway still serve its local socket and HTTP clients directly, or
   should joining make it fleet-only? Proposal: still serves locally;
   capacity accounting arbitrates.

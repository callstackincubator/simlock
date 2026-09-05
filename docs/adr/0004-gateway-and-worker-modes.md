# 0004. Gateway and worker modes

- **Status:** Proposed
- **Date:** 2026-09-05
- **Issue:** none yet
- **Supersedes:** nothing

> This record is a PRD and an ADR in one file: the first half says what the
> feature is and who it is for, the second half records the shape it takes
> and why. Everything under [Open questions](#open-questions) is still being
> decided; everything else is the current proposal.

## Summary

Simlock gains a second run mode. A **worker** is what every simlock daemon is
today: it owns the devices on one machine. A **gateway** owns no devices at
all. It knows a set of workers, keeps a live picture of each one (health,
capacity, queue, leases, devices), routes every lease request to the worker
best placed to serve it, and is the one address the outside world — agents,
the web console, agent-device — talks to. To a client, a gateway looks like a
single, larger simlock.

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
machine a device lives on. Adding a machine means starting a worker on it and
telling the gateway about it. Nothing an agent already does against a single
simlock has to change.

## Users

- **Agent (remote).** Requests a lease from the gateway over HTTP or MCP,
  gets a device somewhere in the fleet, renews and releases it through the
  same URL. Never learns a worker's address unless it needs one to reach the
  device.
- **Operator.** Adds and removes workers, drains one for maintenance, sees
  every machine's health, capacity, queue, and leases in one `simlock status`
  and one console.
- **Machine owner running a worker.** Keeps using their local simlock
  exactly as today. The gateway is one more operator-token client of their
  daemon.

## Non-goals

- **A new wire protocol between gateway and worker.** The gateway is an HTTP
  client of the worker's existing, documented `/v1` API.
- **Proxying the data plane.** The gateway hands out leases; driving the
  device (adb, simctl, screen) still happens against the worker that owns it.
  `dataPlane` on the lease object stays reserved.
- **A gateway that also owns devices.** One process, one mode. A machine
  that should do both runs two daemons.
- **A global queue with cross-worker fairness.** v1 routes a request to one
  worker and lets that worker's FIFO queue hold it (see Decision 6).
- **Building the multi-worker console.** #88 stays its own PRD; this record
  only adds the endpoints the console needs to show many workers.
- **Worker auto-discovery** (mDNS, cloud tags). Workers are configured.

## Vocabulary

| Term | Meaning |
|---|---|
| worker | A simlock daemon in today's mode: drivers, registry, capacity, leases. `mode: "worker"`, the default. |
| gateway | A simlock daemon with no drivers and no device registry, fronting a set of workers. `mode: "gateway"`. |
| worker record | What the gateway persists about one worker: `id`, `url`, an operator token for it, and `drain` state. |
| worker view | What the gateway currently knows about one worker: reachability, daemon health and version, capacity per platform, queue depth, leases, devices, catalog. Rebuilt from the worker, never persisted. |

"Host" is deliberately not used for the gateway: agent-device already calls
its own supervising process the Host (#70), and the docs use "host" for the
physical machine.

## Requirements

### Modes

1. `config.mode` selects `worker` (default) or `gateway`. One daemon runs
   exactly one mode; `simlock daemon start` starts whichever is configured.
2. A gateway starts no drivers, validates no device roots, and runs no
   reaper, health monitor, or capacity strategy. Of the existing config it
   reads only `http.*`, `log.*`, and `eventBuffer.*`; worker-only keys in a
   gateway's config are ignored with a warning, as unknown keys are today.
3. A worker needs no configuration change to be fronted by a gateway. It
   needs `http.enabled: true` and an operator token minted for the gateway.

### Worker registry

4. `simlock worker add <id> --url <url> --token <operator token>` registers a
   worker; `remove`, `drain`, `undrain`, and `list` complete the set. All are
   admin operations on the gateway daemon. Tokens are stored with owner-only
   permissions and never returned by any operation.
5. The gateway keeps one worker view per worker current by polling
   `GET /v1/status` and following `GET /v1/events/stream`; the poll interval
   is configurable. A worker whose poll fails is marked `unreachable` after a
   configurable number of consecutive failures and stops receiving new
   requests until a poll succeeds again.
6. A **drained** worker keeps its existing leases and receives no new
   requests. Draining is the operator's tool for taking a machine down
   without killing anyone's device.

### Routing

7. A lease request arriving at the gateway is admitted to exactly one worker,
   chosen by a routing policy over the current worker views. The v1 policy,
   in order:
   1. drop workers that are unreachable, drained, or lack the requested
      platform, model, or runtime (a download is only considered on a worker
      whose download policy allows it);
   2. prefer a worker with an unleased `ready` device matching the request
      (warm hit: sub-second grant);
   3. otherwise prefer the worker with the most free running capacity for
      that platform;
   4. otherwise (every eligible worker is full) prefer the shortest queue.
   With `noWait`, step 4 is replaced by `NO_CAPACITY`, the same answer a
   single full worker gives.
8. The gateway never provisions, boots, or reclaims anything. Capacity is the
   worker's decision; the gateway only reads it.
9. **One lease per requester is fleet-wide.** A requester holding a lease on
   any worker gets `REQUESTER_ALREADY_LEASED` from the gateway, naming the
   existing lease, regardless of which worker would have been chosen.

### Lease lifecycle through the gateway

10. Every lease the gateway hands out is, on the worker, a detached
    TTL-renewed HTTP lease. Renew, release, cancel, and single-lease reads
    through the gateway forward to the owning worker. Held mode over the
    gateway's own unix socket or MCP is emulated: the gateway renews the
    worker lease for as long as the holding connection lives and releases it
    when the connection closes, so `simlock lease` and the MCP server work
    against a gateway unchanged.
11. A gateway lease id names its worker, so the gateway can route a renew,
    release, or read without consulting any state of its own. Clients treat
    the id as opaque.
12. The lease object gains `worker: { id, url }` (additive) so a client can
    reach the device.
13. Lease-scoped pushes (`lease-lost`, `device-unhealthy`,
    `device-recovered`) relayed by the worker's event stream are re-pushed by
    the gateway to whichever of its connections owns the lease, exactly as a
    worker does today.

### Status, events, catalog

14. `status.get` on a gateway returns the same shape a worker returns —
    capacity summed across reachable workers, all leases, all devices, total
    queue depth — plus an additive `workers` array with one entry per worker
    view. Every device and lease in the aggregate carries `workerId`.
15. `catalog.get` on a gateway is the union of worker catalogs, each model and
    runtime annotated with the workers that have it.
16. Worker business events are republished on the gateway's bus with
    `workerId` added to the payload, and land in the gateway's own ring
    buffer, so `simlock events --follow` against a gateway shows the fleet.
    The gateway emits its own facts for `worker.added`, `worker.removed`,
    `worker.lost`, `worker.recovered`, `worker.drain-started`,
    `worker.drain-ended` (documented in `EVENTS.md` in the same change).
17. New admin operation `worker.list` and HTTP route `GET /v1/workers` return
    the worker views; `worker.add|remove|drain|undrain` map to
    `POST /v1/workers`, `DELETE /v1/workers/{id}`,
    `POST /v1/workers/{id}/drain`, `DELETE /v1/workers/{id}/drain`. These are
    what the console (#88) renders.

### Authentication

18. Client → gateway: the gateway has its own token store and mints its own
    `agent`/`operator` tokens with `simlock token`, exactly as a worker does.
    A gateway token is never valid on a worker and vice versa.
19. Gateway → worker: one operator token per worker, supplied at
    `worker add`. Because it is an operator token, the gateway can see and
    release every lease on the worker; the gateway enforces per-requester
    ownership itself before forwarding, so an agent token on the gateway
    cannot reach another requester's lease through it.
20. The requester id the gateway forwards to a worker is namespaced by the
    gateway (`gw:<gateway instance id>:<requester>`) so a local agent on the
    worker machine and a remote one behind the gateway can never collide on
    the one-lease rule or on attribution.

### Failure behaviour

21. **Worker unreachable.** New requests skip it. A renew or release for a
    lease on it fails with a new closed error code `WORKER_UNREACHABLE`
    (`kind: "transport"`); the worker's own TTL eventually expires the lease
    and reclaims the device, and the gateway relays `lease-lost` once it
    sees the worker's `lease.expired` fact. The gateway never guesses a
    lease is gone before the worker says so.
22. **Gateway restart.** In-flight lease *requests* are lost, exactly as a
    worker restart loses them today (#72 covers durability on the worker;
    the gateway inherits it once it lands). Leases survive, because they
    live on workers and the gateway needs no state to route to them
    (requirement 11). Held-mode emulation stops renewing, so a held lease
    through a restarted gateway expires on its worker TTL — the same
    outcome a worker restart gives a held lease today.
23. **Version skew.** The gateway requires a worker to answer
    `GET /v1/status` with a shape it understands; a worker whose HTTP API is
    newer works (additive evolution), one that is older than the gateway's
    minimum is marked `incompatible` and skipped, with the reason in its
    worker view.

### Engineering

24. The gateway is a second implementation of the daemon contract's handlers
    (ADR 0003 §2), not a second contract: `src/gateway/` provides a
    `Dispatcher` whose handlers fan out over HTTP instead of calling `core`.
    Every existing frontend — CLI, MCP, HTTP, `simlock/client` — works
    against a gateway with no frontend change, because they only ever see the
    contract.
25. `src/gateway/` imports nothing from `core` or `drivers` (enforced like
    `src/contract/boundary.test.ts`). It depends on the contract, the bus,
    and the ports (`Clock`, an HTTP client port, `Filesystem`).
26. Operations that only make sense against real devices — `nuke.run`,
    `cleanup.run`, `doctor.run`, `driver.passthrough` — answer
    `UNSUPPORTED_IN_GATEWAY_MODE` in v1. They stay a per-worker, direct
    operation. `config.get` returns the gateway's own config.
27. Tests: one suite per gateway handler against scripted worker HTTP
    responses and a manually-advanced `Clock` (routing choices, unreachable
    and drained workers, fleet-wide one-lease rule, lease id routing, held
    emulation). One e2e test starts two fake-driver workers and a gateway
    and leases through the gateway.

## Decision

1. **The gateway speaks to workers through their existing HTTP API and
   nothing else.** A worker cannot tell a gateway from any other operator
   client. This is what makes "a worker needs no change" true and keeps the
   gateway upgradeable independently of workers.
2. **The gateway implements the contract, not a new API.** Anything that can
   talk to a simlock daemon can talk to a gateway. The console, agent-device,
   MCP, and the CLI get fleet support for free; the routing logic lives in
   one place.
3. **The gateway holds no device state.** Worker views are caches rebuilt
   from workers; lease ids carry their worker; the only persisted gateway
   state is the worker registry and its own token store. A gateway restart
   loses nothing a worker restart would not also lose.
4. **Capacity and safety stay on the worker.** The gateway never touches a
   device, so every safety rule in `docs/agent-rules/safety.md` keeps
   holding by construction: registry-only destruction, never touching a
   leased device, no implicit downloads (the gateway forwards
   `allowDownload` and the worker clamps it through its own policy).
5. **Routing is a pure function over worker views.** Policy is a module with
   one entry point, selected by config (`gateway.routing`), the same shape
   as `CapacityStrategy`. The v1 policy is "warm hit, else most free
   capacity, else shortest queue"; nothing else in the gateway knows how a
   worker is chosen.
6. **No gateway-side queue in v1.** A request admitted to a full worker waits
   in that worker's FIFO queue. The cost: a device freeing on another worker
   does not help it. The benefit: no gateway-held demand state to make
   durable, no second fairness model, and the same progress states the
   worker already emits. A gateway queue is the obvious follow-up once the
   routing views show it is needed.

## Consequences

- The contract gains: `mode` in `status.get`'s daemon block, `workerId` on
  devices and leases, `workers` on status, `worker.*` operations, and two
  error codes (`WORKER_UNREACHABLE`, `UNSUPPORTED_IN_GATEWAY_MODE`). All
  additive.
- `docs/HTTP-API.md` gains the `/v1/workers` routes and drops "multi-host
  brokering" from "Not implemented"; `docs/IDEAS.md` drops "Cross-machine
  coordination"; #88 drops its "one console per daemon" non-goal.
- Two operator tokens per worker machine instead of one becomes normal:
  one for the gateway, one for whoever administers the worker directly.
- Sequencing, one PR each, each leaving the tree working:
  1. `config.mode`, `src/gateway/` skeleton, worker registry and
     `worker.*` operations, worker views from polling, aggregated
     `status.get`/`catalog.get`/`events.*`, `GET /v1/workers` — the fleet is
     visible before it is routable, which is what the console needs first;
  2. routing policy, `lease.request`/`renew`/`release`/`cancel`/`list`
     forwarding, fleet-wide one-lease rule, lease pushes relayed;
  3. held-mode emulation over the gateway socket (CLI and MCP against a
     gateway), drain semantics, `WORKER_UNREACHABLE` handling, e2e test;
  4. docs, changelog, and the #88 endpoints.

## Alternatives considered

- **Workers dial out to the gateway (push registration).** Friendlier to
  workers behind NAT, but it needs a new protocol, a persistent connection
  per worker, and a join secret, and it breaks "a worker needs no change".
  Rejected for v1; the worker record is `url`-based, and reaching a worker
  is the operator's tunnel, as it already is for the HTTP API.
- **Redirecting clients to the worker after the grant.** Keeps the gateway
  out of the renew path but makes every client fleet-aware and leaks worker
  tokens or requires per-worker client tokens. Rejected: the gateway is the
  contact point, so it proxies the whole lease lifecycle.
- **A gateway that is also a worker (hybrid mode).** Tempting for a two-Mac
  setup, but every gateway code path would need a "local" special case, and
  the gateway's "holds no device state" property would be lost. Rejected;
  run two daemons with distinct `SIMLOCK_HOME`s on that machine.
- **Global queue at the gateway.** Better fairness, at the cost of durable
  demand state on the gateway and a second progress model. Deferred, see
  Decision 6.
- **A new gateway↔worker RPC.** Would allow held-mode pass-through and
  richer status, but duplicates the HTTP API. Rejected; if the HTTP API
  lacks something the gateway needs, add it to the HTTP API, where every
  other remote client benefits.

## Open questions

Answers to these change the requirements above, not just the wording.

1. **Connection direction.** Gateway polls workers by URL (proposed), or
   workers register themselves with the gateway and keep an outbound
   connection? The second suits workers behind NAT but costs a new protocol.
2. **Naming.** `gateway`/`worker` (proposed, avoids agent-device's "Host"),
   or `host`/`worker` as the original ask phrased it?
3. **Queueing.** Per-worker queues only (proposed), or a gateway queue from
   day one so a request can be granted by whichever worker frees first?
4. **Held mode through the gateway.** Emulate it (proposed, so CLI and MCP
   work unchanged) or make the gateway HTTP/detached-only like the worker's
   own HTTP API?
5. **Fleet-wide one-lease rule.** Enforce at the gateway (proposed) or let a
   requester hold one lease per worker?
6. **Hybrid.** Is "a gateway never owns devices" acceptable, or does the
   two-Mac case need the gateway machine to also serve devices?
7. **Worker data plane.** Is returning `worker.url` on the lease enough for
   the client to reach the device, or must the gateway also proxy adb and
   `driver.passthrough`?
8. **Routing tie-breakers.** Any placement constraint beyond capacity —
   pin a requester to a worker, prefer a worker by label (e.g. Xcode
   version), or avoid a worker for a platform?
9. **Persistence of the worker registry.** File under `SIMLOCK_HOME`
   (proposed) or config.json entries? The token argues for a 0600 file.
10. **Which operations fan out.** Should `doctor.run` and `cleanup.run`
    through the gateway fan out to every worker (with `workerId` on each
    finding) instead of being unsupported?

# Gateway

Does: a daemon in `mode: "gateway"`: owns no devices, fronts the workers that dial in.
Entry: `index.ts`; `startGatewayDaemon` (`../daemon/main.ts`) wires `GatewayService`,
`FleetLeaseCoordinator`, `GatewayDispatcher`, `GatewayRelay`, `GatewayOwnerRoutedFacts`.
Uses: bus, contract, ports, link, admin, simlock-client, `../daemon/dispatch.ts`, and from
core and leasing only the names `.oxlintrc.json` allows (request book, in-memory store, wait queue).
Never imports: drivers, the rest of daemon, core's registry, capacity or lifecycle.
Imported by: `../daemon/main.ts`. This manual also covers the worker's end of the uplink.
Flows: [device selection](../../docs/internal/flows/device-selection.md),
[device.exec](../../docs/internal/flows/device-exec.md), [leasing](../leasing/AGENTS.md).

## Files

| File                          | Role                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| `service.ts`                  | `GatewayService`: uplink listener, one `WorkerLink` per worker, 30 s tick   |
| `worker-link.ts`              | One uplink, gateway side: admin client, view reads, event relay             |
| `worker-registry.ts`          | `WorkerRegistry`: views, drain, retention, `worker.*` events                |
| `drain-store.ts`              | `FileDrainStore`: `workers.json`, the drained ids                           |
| `dispatcher.ts`               | `GatewayDispatcher`: the contract's handlers, answered from the fleet       |
| `fleet-coordinator.ts`        | `FleetLeaseCoordinator`: admit, dispatch, retry, forward renew/release/exec |
| `queue.ts`                    | `FleetQueue`: leasing's `WaitQueue`, two lines                              |
| `lease-index.ts`              | `FleetLeaseIndex`: gateway lease id → worker, worker lease id, owner        |
| `routing.ts`, `routing/`      | `createRoutingPolicy`: `assess` and the stage list                          |
| `owner-routed-facts.ts`       | Relayed lease facts → `lease-lost` and device pushes to the owner           |
| `aggregate.ts`                | `aggregateStatus`, `aggregateCatalog`: pure, over views                     |
| `component-relay.ts`          | `relayComponentInstall`: `worker.install-component` fan-out                 |
| `relay.ts`                    | `GatewayRelay`: one HTTP exchange to a worker's relay target                |
| `fleet-ports.ts`              | `WorkerDirectory`, `FleetViews`, `liveClient`, `isUplinkLost`               |
| `../daemon/gateway-uplink.ts` | Worker: `GatewayUplink`, dial and redial                                    |
| `../daemon/relay.ts`          | Worker: `RelayConnection`, serves `relay.request`                           |
| `../link/`                    | Both ends: text messages plus byte channels on one WebSocket                |

## How it works

**Uplink, worker side.** `../daemon/main.ts` builds `GatewayUplink` only when `gateway.url` and
`gateway.token` are both set, and starts it after the socket is claimed and the first host load reading.

1. Dial `<gateway.url>/v1/uplink` (`WebSocketUplinkConnector`): `Authorization: Bearer <join token>`,
   `x-simlock-worker-id` (the worker's `instance.json` id), `x-simlock-worker-label`.
2. Wrap it in `createLink(..., { end: "worker" })` → `DaemonServer.acceptUplink`: one more
   connection, role forced to `admin`, `isGatewayUplink: true`, its own `RelayConnection`.
3. Any failure or close → redial: 1 s × 2, cap 30 s, jitter ×[0.5, 1]. Backoff resets after 30 s up.
4. On close the worker aborts that connection's relays. Leases, requests and exec keep running.

**Uplink, gateway side.**

1. `GatewayService.start`: `registry.load()` (drained ids) before the listener opens.
2. Upgrade auth (`../daemon/main.ts`): unknown token `401`, non-`worker` role `403`. Refusals emit
   `worker.rejected`, coalesced per reason and claimed id over 1 s.
3. A new uplink under a live worker id closes and replaces the old link.
4. `WorkerLink.start`: `hello` as `gw:<instance id>`, `status.get`. Protocol mismatch →
   view `incompatible`; role not `admin` → close. Then `worker.connected`, `events.subscribe`,
   first refresh with catalog. Each of these reads waits at most 10 s (`WORKER_CALL_TIMEOUT_MS`).
5. Refresh: `status.get`; a `starting` worker stops there. Else `list.get` devices, plus
   `catalog.get` and `config.get` on the tick, after `component.installed`, or with no catalog yet.
   One at a time; refreshes asked meanwhile merge into one. 2 timed-out refreshes in a row → close.
6. Worker events are republished with `workerId`. `lease.*`, `device.*`, `component.install*`
   trigger a refresh. A worker event named like a gateway fact (`worker.*`, `request.dispatched`, `request.granted`) is dropped.

**Fleet request** (`FleetLeaseCoordinator.request`, under its own `SerializedDecision`; routing's
`assess` and nine stages are in [routing](routing/AGENTS.md)):

1. `GatewayDispatcher` refuses `fleetRequestId` and, off an uplink session, `owner`. Fills `ttlMs`
   from the gateway's `lease.defaultTtlMs`; rejects one above `lease.maxTtlMs`. Drops `allowDownload`.
2. Admit: idempotent replay → `lease.maxPerRequester` (1) over the index plus a pending request
   (`already-leased`) → `leaseId` held by the index or an open request (`lease-id-taken`) →
   `requests.admit` stores it, creates the waiter. Emits `lease.requested`.
3. Walk (on admit, on any view change, after each settled attempt), oldest first: `assess` the
   request over views minus workers that said cannot-serve. A reject ends the request.
   Else `select` over workers not claimed this pass and not refused at their current `viewLoadKey`.
4. No pick: `noWait` → `NO_CAPACITY`; else queue (`lease.queued`).
5. Attempt: `requestLease` on the picked worker with `requesterId: gw:<id>:<requester>`, `owner`,
   `noWait: true`, `allowDownload: false`, `fleetRequestId`, the worker's own model name.
   Bounded by `gateway.leaseRequestTimeoutMs`. First progress push → `request.dispatched`.
6. Answers before any progress: `NO_CAPACITY` → remember refusal, refresh view, re-queue
   (`noWait`: one more walk). `UNKNOWN_MODEL`, `RUNTIME_MISSING`, `NO_DRIVER`, `CAPABILITY_MISSING`
   → exclude that worker for this request, refresh its catalog, walk again. Anything else, or any
   failure after progress → `lease.rejected` `worker-failed`.
7. Grant: a lease id unlike the forwarded `leaseId` → release it on the worker, retry. Gateway
   lease id = the caller's `leaseId`, else `<workerId>.<workerLeaseId>`. `leaseIndex.add`, then
   `request.granted`; a clash → release on worker, `LEASE_ID_TAKEN`.

**After the grant.** Renew, release, release-all and exec go to the worker named by the index;
no live link → `WORKER_UNREACHABLE`; a worker `UNKNOWN_LEASE` drops the entry. The gateway runs
no TTL timer. Relayed `lease.expired`/`lease.released` remove the entry and push `lease-lost`.
Exec forwards the namespaced requester; `gateway.execTimeoutMs` is a backstop over the worker's `exec.timeoutMs`.
The lease index is in memory, rebuilt from each view's leases whose requester starts `gw:<id>:`;
missing from 2 snapshots in a row → dropped; kept across a disconnect, forgotten with the view.

**HTTP relay** (`GatewayRelay.relay`, used by `../agent-device/front/relay-host-link.ts` and `../stream/`):

1. `openChannel`, then `relay.request` (ids, target, method, url, headers minus credentials, `tenant`, `channel`).
2. Request body up and response body down on that byte channel; head from the `relay-head` push.
3. Caller abort or cancel → `relay.cancel`. Deadline for the channel and head, then an idle bound on
   the body (a live body runs while bytes come), both on the Clock → `WORKER_UNREACHABLE`, `relay.cancel`.
4. Worker: `relay.*` only on the uplink session (`FORBIDDEN` elsewhere; a gateway refuses them
   from everyone). Target from `relayTargets`; unknown → `RELAY_TARGET_MISSING`.

**Reads.** `status.get`, `catalog.get`, `list.get`, `lease.list` (admin: all; else own) answer from
views. `worker.install-component` fans out. `nuke.run`, `cleanup.run`, `doctor.run`,
`driver.passthrough`, `component.*`, `device.add`, `device.remove` → `UNSUPPORTED_IN_GATEWAY_MODE`.

**Uplink drop.** View → `disconnected`, kept; `worker.disconnected`. In-flight calls → `WORKER_UNREACHABLE`, an in-flight lease request → `worker-failed`. `token.revoke` closes its uplinks.

## State and timers

| What                                   | Default                                  | Key                                                   |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| View refresh tick (+ prune)            | 30 s                                     | `WORKER_VIEW_REFRESH_INTERVAL_MS`                     |
| One view read                          | 10 s                                     | `WORKER_CALL_TIMEOUT_MS`                              |
| Forwarded `lease.request`              | 5 min                                    | `gateway.leaseRequestTimeoutMs`                       |
| Forwarded `device.exec`                | 11 min                                   | `gateway.execTimeoutMs`                               |
| Disconnected view kept                 | 24 h, held while a gateway lease is live | `gateway.disconnectedRetentionMs`                     |
| Relay: channel + head / silent body    | 330 s / 330 s                            | `GatewayRelayOptions.deadlineMs` / `.idleMs`          |
| Link: channels per side, accept, stall | 64, 30 s, 60 s                           | `../link/` constants                                  |
| Request records                        | 10 000, 10 min                           | `lease.maxRequestRecords`, `lease.requestRetentionMs` |

Persisted: `workers.json` (drained ids), `tokens.json`, `instance.json`. Nothing else.

## Rules

- The gateway never decides a lease is gone; only the worker's relayed fact or answer ends it.
- No gateway request waits in a worker queue: every dispatch is `noWait: true`.
- A gateway forwards `allowDownload: false`, always.
- Only the gateway's prefix `gw:<instance id>:` marks its leases; `release-all` and retention read it.
- Only `WorkerLink` republishes onto the bus (`boundary.test.ts`).
- Routing reads views only; stage order is code, never config.

## Known gaps

- **A fleet request is stored only once a worker takes it.** A gateway restart loses every open
  request; ids answer `404`, a repeated `Idempotency-Key` is new. Leases survive, so a repeat may get
  `REQUESTER_ALREADY_LEASED` naming the lease.
- **A dispatched request whose uplink drops may have granted a lease anyway.** Client sees
  `WORKER_UNREACHABLE`; the lease stands on the worker until TTL. Re-request: at the limit the
  answer names the earlier lease once the index is rebuilt; below it you get a second lease.
- **A lease survives a gateway restart, but nothing can renew it until the gateway is back.**
  Renew, release and exec fail meanwhile; past the TTL it expires. Knob: the gateway's
  `lease.defaultTtlMs`, or `--ttl`.
- **Local agents and the gateway share a worker's capacity.** A busy local machine answers
  `NO_CAPACITY`; the request waits for another worker. `simlock worker drain` leaves it to its owner.
- **A worker's claimed id is never verified against its join token.** Any `worker`-token holder can
  claim any id and take over that worker's link, view, drain flag and forwarded calls. Ids cut to 128 chars.
- **`device.exec` backpressure through a gateway does not slow the worker's own process.**
  Output is relayed with `void session.onOutput(...)`; a slow fleet client is buffered in the gateway.
- **Three gaps in gateway warm hits.** A slim-pool device that failed its slim pass reports `full`
  and counts for `full`; a default-slim worker's full device on an unslimmable runtime is no hit for
  a mode-less request; a `--mode slim` request on an unslimmable runtime is no hit on a ready full device.

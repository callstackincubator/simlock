# Gateway

Does: a daemon started with `--gateway` (it lives in `<root>/gateway`): owns no devices, fronts the workers that dial in.
Flows: [device selection](../../docs/internal/flows/device-selection.md), [device.exec](../../docs/internal/flows/device-exec.md), [worker update](../../docs/internal/flows/worker-update.md), [leasing](../leasing/AGENTS.md).

This manual also covers the worker's end of the uplink.

## Rules

Trust in a worker:

- A worker must not be able to crash, stall or corrupt its gateway. A bad worker reply fails that call. Every view read is bounded, and a link whose refreshes keep timing out is closed.
- Only `WorkerLink` republishes onto the bus (`boundary.test.ts`). It adds `workerId` and keeps the worker's own event id, name and timestamp.
- A worker event named like a fact only a gateway authors (`GATEWAY_OWN_EVENTS` in `worker-link.ts`) is dropped; any other name is forwarded, known here or not. An event nested past `MAX_RELAYED_PAYLOAD_DEPTH`, or one that cannot be serialized, is dropped.
- Only a `worker` token pinned to the claimed worker id opens an uplink. A new uplink under a live worker id closes and replaces the old link. `token.revoke` closes the token's uplinks.
- A protocol mismatch does not close the link: the view is `incompatible`, and that worker is asked only `daemon.update` with `query`.
- A gateway refuses `fleetRequestId` and `owner` on `lease.request` from everyone: only a gateway sets them, on its own dispatch to a worker.

Leases:

- The gateway never decides a lease is gone; only the worker's relayed fact or answer ends it. It runs no TTL timer.
- No gateway request waits in a worker queue: every dispatch is `noWait: true`.
- A gateway forwards `allowDownload: false`, always.
- Only the gateway's prefix `gw:<instance id>:` marks its leases; the lease index (and so `release-all`) and retention read it.
- The lease index is rebuilt from each view's leases. An entry goes only when consecutive snapshots lack it; it is kept across a disconnect and forgotten with the view.
- A lease the worker answered released or `UNKNOWN_LEASE` is not added back by a later snapshot that still lists it. A worker's `UNKNOWN_LEASE` drops the entry.
- A refusal is remembered against the worker's `viewLoadKey`, so the worker is asked again only once its view changes. `DAEMON_UPDATING` is handled as `NO_CAPACITY`.
- A worker's failure before its first progress push sends the request on to another worker or back to the queue. After a progress push it is the request's own end (`worker-failed`): device work had started.
- A granted lease id unlike the forwarded `leaseId` is not believed: it is released on the worker and the request tries again.
- `lease.maxPerRequester` counts the index plus a pending request, but not a lease past its last reported deadline on a disconnected worker.
- `gateway.execTimeoutMs` is a backstop over the worker's `exec.timeoutMs`, not the limit.

State and reads:

- Persisted: the drained ids, the tokens and the ended chosen lease ids (`lease.endedIdRetentionMs`, ADR 0074 §4) in `state.db`, `instance.json` and the event history. The lease index, the views and the fleet requests live in memory only.
- The registry loads the drained ids before the uplink listener opens.
- A disconnected view is kept for `gateway.disconnectedRetentionMs`, and for as long as one of this gateway's leases on it is live.
- Reads answer from the views, never from a worker call. A `starting` view has no catalog and no baselines, and `routingViews` puts the last ones back.
- A non-admin sees only what its principal owns: its index entries, its waiting fleet requests, and `workers[]` without each worker's own `leases` and `waiting`.
- An uplink drop keeps the view as `disconnected`. In-flight calls answer `WORKER_UNREACHABLE`, and an in-flight lease request ends `worker-failed`.

Relay:

- `relay.*` runs only on a worker's uplink session. A gateway refuses them from everyone.
- A worker never holds a gateway credential: `relayHeaderPairs` (`../contract/relay.ts`) drops the credential headers and the configured `http.proxyAuth.header`.
- Every wait is bounded on the `Clock`: one deadline for the channel and the head, then a silence bound on the body. At either limit: `WORKER_UNREACHABLE`, and `relay.cancel` to the worker.
- A file upload (`upload` on the call) is bounded by `UPLOAD_STALLED` silence of the caller instead; its head deadline starts at the body's end.
- A two-way relay keeps both directions open after a 2xx head; ending one ends only that one.
- Its silence bound (`TWO_WAY_SILENCE_MS` in `relay.ts`) counts only bytes read from the worker. Bytes the gateway writes never reset it, and it stops while the relay's read-ahead is full. A worker module keeps it alive with the heartbeat in `../modules/relay-channel.ts`.
- On an uplink close the worker aborts that connection's relays. Leases, requests and exec keep running.

## Flow: a lease through a gateway

1. `GatewayDispatcher` fills and caps `ttlMs` from the gateway's own `lease` config and drops `allowDownload`.
2. `FleetLeaseCoordinator` admits under its own `SerializedDecision`: replay, requester limit, taken lease id, ended lease id, then it stores the request and emits `lease.requested`.
3. It walks the open requests, oldest first, on admit, on any view change and after each settled attempt. [Routing](routing/AGENTS.md)'s `assess` ends a request no worker can serve; `select` picks among workers not claimed this pass and not refused at their current view.
4. No pick: a `noWait` request ends `NO_CAPACITY`; any other queues in the gateway (`lease.queued`).
5. A pick: `lease.request` goes to that worker's [leasing](../leasing/AGENTS.md) over its uplink, as requester `gw:<id>:<requester>`, bounded by `gateway.leaseRequestTimeoutMs`. The first progress push emits `request.dispatched`; a refusal before it starts another walk without that worker.
6. Grant: the gateway lease id is the caller's `leaseId`, else `<workerId>.<workerLeaseId>`. The index entry is added, then `request.granted` is emitted. The worker's view is read again before any answer.
7. Afterwards renew, release, exec, rotate and baseline save go to the worker the index names; with no live link they answer `WORKER_UNREACHABLE`.
8. The worker's relayed `lease.expired` or `lease.released` removes the entry and pushes `lease-lost` to the owner.

## Known gaps

- **A starting worker's leases are hidden from their owner.** `lease.list` and `lease.get` omit them
  for the startup checks plus one refresh. Meanwhile remote commands fail with
  "No lease is held by …" and MCP `status()` reports none; the lease stands. Don't request a new device.
- **A lease that ended while the gateway was down is not recorded by it.** A chosen id it never saw end is dispatched, and the worker that held the lease answers `LEASE_ENDED` (`worker-failed`); another worker grants it.
- **A fleet request is stored only once a worker takes it.** A gateway restart loses every open request;
  ids answer `404`, a repeated `Idempotency-Key` is new (maybe `REQUESTER_ALREADY_LEASED`).
- **A dispatched request whose uplink drops may have granted a lease anyway.** Client sees
  `WORKER_UNREACHABLE`; the lease stands until TTL. A re-request may name it or get a second lease.
- **A lease survives a gateway restart, but nothing renews it until the gateway is back.** Renew, release and exec fail meanwhile; past the TTL it expires. Knob: `lease.defaultTtlMs`/`--ttl`.
- **Local agents and the gateway share a worker's capacity.** A busy machine answers `NO_CAPACITY`. `worker drain` leaves it to the owner.
- **`device.exec` backpressure through a gateway does not slow the worker's own process.** Output is relayed with `void session.onOutput(...)`; a slow fleet client is buffered in the gateway.
- **A worker's future-stamped event keeps its own timestamp.** ADR 0014 §2 has the gateway republish the worker's `timestamp`; amending the ADR is the maintainer's call.
- **Gateway warm hits miss some devices.** A slim-pool device that failed its slim pass reports `full`
  and counts for `full`; a default-slim worker's full device on an unslimmable runtime is no hit for a
  mode-less request; a `--mode slim` request there is no hit on a ready full device.

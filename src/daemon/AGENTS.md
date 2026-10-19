# Daemon

Does: one process per data directory — composes a worker or a gateway and serves the contract on a unix socket.
Entry: `main.ts` → `startDaemon(options)` → a started `DaemonServer`.
Uses: auth, contract, daemon-protocol, ports, bus, history, link, core, leasing, drivers, http, host-load, modules, module-registry; gateway from `main.ts` only.
Never imports: gateway outside `main.ts`. `dispatch.ts` imports no core, drivers or http.
Imported by: http (`dispatcher.ts`, `error-code.ts`, `owner-routed-facts.ts`); gateway (`dispatch.ts` only).
Started by: cli and mcp spawn `main.ts` as a detached process.
Flows: [startup](../../docs/internal/flows/startup.md), [device.exec](../../docs/internal/flows/device-exec.md), [gateway](../gateway/AGENTS.md).

## Files

| File                    | Role                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `main.ts`               | Composition root; worker or gateway; driver discovery; log sinks       |
| `server.ts`             | `DaemonServer`: framing, `hello`, sessions, pushes, readiness, stop    |
| `dispatch.ts`           | `runDispatch` pipeline, `DispatchSession`, `DispatchError`             |
| `dispatcher.ts`         | `Dispatcher`: the worker's handlers                                    |
| `connection-host.ts`    | `DaemonEndpointHost`: socket claim, stale-socket recovery              |
| `owner-routed-facts.ts` | `OwnerRoutedFactBus`: lease facts with their owner                     |
| `gateway-uplink.ts`     | `GatewayUplink`: a worker's dial to its gateway                        |
| `relay.ts`              | `RelayTargets`, `RelayConnection`: relays over the uplink              |
| `error-code.ts`         | `classifyError`: thrown error → contract code                          |
| `enrollment-wake.ts`    | `wakingQueueAfter`: wakes the queue after `device.add`/`device.remove` |
| `test-relay-support.ts` | Test helpers for relay e2e tests                                       |

## Composition (`main.ts`)

Both modes: config (`config.json`) → `Logger` → host info → `EventBus` → event history (`createEventHistory`, not yet started) → `createAuth` (`src/auth`, once).
`config.mode` then picks one branch; a gateway builds none of the worker's parts.

- **Worker** — `Registry` (`state.json`) → instance id (`instance.json`) →
  `discoverDrivers` (validates each root; a refused root costs that platform only) →
  `ComponentInstaller` → `createCore` → `createLeasing` → `core.connect` →
  `CleanupReaper`, `Nuke` → `GatewayUplink`
  when `gateway.url` and `gateway.token` are both set → `DaemonServer` with `Dispatcher`.
  HTTP starts only when `http.enabled`.
- **Gateway** — instance id → `FleetLeaseIndex`
  (requester prefix `gw:<instanceId>:`) → `GatewayService` (uplink listener, `workers.json`)
  → `FleetLeaseCoordinator` → `DaemonServer` with `GatewayDispatcher`. HTTP always
  starts; the uplink upgrades on the same listener.

An HTTP bind failure after a good start stops the daemon (`http-start-failed`).

## Connection (`server.ts`)

1. **Claim** — `DaemonEndpointHost.start`: a live peer → `DaemonAlreadyRunningError`;
   a dead socket file is removed and claimed. Default `<data dir>/daemon.sock`.
2. **Hello** — first frame must be `hello`, else `HANDSHAKE_REQUIRED` and close.
   Role: the uplink connection is `admin` by acceptance; otherwise the resolver.
   Principal: `hello.principal`, else `SIMLOCK_AGENT_ID`, else the daemon's pid.
   Both are fixed for the connection's life.
3. **Version** — ranges overlap → highest common version. `PROTOCOL_VERSION_RANGE`
   is `{ min: 47, max: 47 }` (`src/contract/protocol.ts`). No overlap → the
   connection stays open, and every request but `daemon.stop` gets
   `PROTOCOL_VERSION_UNSUPPORTED`.
4. **Request** — one frame → one `dispatch()` call. While stopping: `DAEMON_STOPPING`.
5. **`daemon.stop`** — handled by the server, before the version and stopping gates.
   Needs `admin`. Answers `{ stopping: true }`, then stops.

Pushes, keyed by the request's frame id: `progress` (`lease.request`), `started` and
`output` (`device.exec`), `component-progress`, `relay-head`. Per connection: `event`
(`events.subscribe`). Owner-routed: `lease-lost`, `device-unhealthy`,
`device-recovered` go to every connection whose principal owns the lease; `lease-lost`
skips the connection that asked for that release. A closed connection only silences
its pushes; the request, the lease and a running command go on.

## Dispatch (`dispatch.ts` `runDispatch`)

One pipeline for `Dispatcher`, `GatewayDispatcher` and HTTP:

1. No handler → `UNKNOWN_REQUEST`.
2. Parse input → `BAD_REQUEST`.
3. Role: `admin` passes all; `agent` only `agent` operations → `FORBIDDEN`.
4. `authorize` hook (lease owner lookups) → `FORBIDDEN`. An unknown id passes,
   so the handler answers `UNKNOWN_LEASE`.
5. Park on readiness — every operation but `status.get`.
6. Handler → parse output; a mismatch is logged and answers `INTERNAL`.

## Readiness

`DaemonServer.start`: claim → host load start → `admin.token` write → converge
starts → `onSocketClaimed` (module `afterSocketClaimed`, agent-device, uplink, HTTP) → await converge → arm.
Health: `starting` → `running`, or `failed`.

- `hello` and `status.get` answer at once; `status.get` while `starting` carries
  `daemon`, `host` and `load` only.
- Converge fails → parked requests get `DAEMON_STARTUP_FAILED`; daemon stops
  (`convergence-failed`).
- A stop during converge → nothing is armed, no `daemon.started`.
- Arm: owner-routed push subscription → `daemon.started` → driver refusal events →
  health monitor and physical device watcher start.
- A gateway's dispatcher never parks.

## Identity and roles

Credential resolution (`Auth.resolveHelloRole`, `src/auth`), at `hello`:

1. No credential → `agent`.
2. An `operator` token in `tokens.json` → `admin`.
3. The per-start admin secret → `admin`.
4. Anything else → `ADMIN_AUTHENTICATION_FAILED`, connection closed.

Admin secret: fresh each start, hash kept in memory. Written to `admin.token`
(0600, atomic) only after the claim; removed on stop before releasing the
endpoint, so old shutdown cannot remove a replacement's credential. A daemon
that lost the claim never touches it.

Security model: cooperative identity, not a hostile-process boundary.

- Every socket peer is the same OS user; file modes are the real boundary.
- A `hello.principal` is a claim. Ownership checks stop accidents, not attacks.
- Admin comes only from a credential at `hello`, never from the socket itself.
- A worker that joins a fleet grants its gateway `admin` over itself.

## Uplink and relays (worker side)

- `GatewayUplink` dials `gateway.url` with `gateway.token`, after the first host
  load reading. Backoff from 1 s, ×2, cap 30 s, jittered; retries forever.
- `DaemonServer.acceptUplink` serves it as one more connection, role `admin`.
- `relay.request` runs only on that connection; targets come from `relayTargets`
  (today `agent-device` and `stream`). See [gateway](../gateway/AGENTS.md).

## Logging and event records

- One `operation` line per dispatched call, from `runDispatch` (`dispatch` child):
  operation, principal, role, `durationMs`, `leaseId`/`requesterId`, failure `code`.
  `write` success `info`, `read` success `debug`, failure `info`, `INTERNAL` `error`.
- `daemon.log`: `JsonLinesLogger` over `NodeFileLogSink`; `log.level` (`info`),
  rotates to `daemon.log.1` past `log.rotateBytes` (5 MiB).
- At `log.level: debug`, `LoggingProcessRunner` logs one `process` line per command.
- Events: ring of `eventBuffer.capacity` (1000) in memory; `history.db` via the [history](../history/AGENTS.md), kept `eventLog.retention` (7 days), event rows capped at
  `eventLog.maxBytes` (256 MiB); usage rows are kept `metrics.retention` (90 days). `onSocketClaimed`
  starts it in both modes with `config.mode` and `metrics.retention`; `dispose` stops it last. A file that fails costs only history. A start the history refuses (a newer stored projection version, a
  failed migration) stops the daemon with reason `history-refused` and exit 1. `status.get` carries its `history`, also while starting. `usage.get` (both dispatchers, `usageAnswer` in `dispatch.ts`) reads the same file's usage rows through `core/usage` on a read thread; `main.ts` passes `historyPath` in both modes, and `dispose` stops the thread. `history.status().opened` false → `HISTORY_UNAVAILABLE`; a window ending before the oldest row → `HISTORY_NOT_KEPT`.
- A start that throws is logged by a fallback logger to the default `daemon.log`; exit 1.

## Rules

- One `Dispatcher` instance serves the socket, the uplink and HTTP; HTTP calls
  `DaemonServer.dispatch` in process.
- Handlers never see raw input and never check roles.
- The claim comes before any write to `admin.token` and before converge.
- On a worker, no request but `hello`, `status.get` and `daemon.stop` runs before
  converge ends.
- `daemon.stop` releases nothing. Leases persist with their deadlines.
- A closed connection ends no lease and kills no command.
- `daemon.started` is emitted only after converge, and never after `daemon.stopping`.

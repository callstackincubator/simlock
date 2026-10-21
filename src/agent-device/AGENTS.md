# Agent-device edge

Does: runs one agent-device daemon per worker and serves the agent-device CLI at `/v1/agent-device/*`, one simlock lease per agent-device lease.
Entry: `index.ts` → `agentDeviceModule`. The front parts live in `front/edge-parts.ts` (`createGatewayAgentDeviceFrontParts`, `createAgentDeviceFront`, `disposeAgentDeviceEdge`, `cancelWaitingAllocates`). The gateway half is `gateway.ts` (`createGateway`, builds the `FleetPort` from the gateway context); the worker half is `worker.ts` (`createAgentDeviceEdgeParts`, builds `AgentDeviceSupervisor`). The module host loads both.
Uses: ports, auth (`Identity`), http (session, errors), contract types, core and leasing types. Never imports: gateway, drivers, `fs`, `child_process`.
Imported by: the module registry (`index.ts` only); `daemon/main.ts` imports nothing from it (tests may use `testing.ts`). Pinned in `lint-rules.test.ts`.
Off unless `capabilities.agent-device.enabled` (false). Off: nothing mounted, no daemon.

## Files

| File                                                          | Role                                                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition.ts`                                               | `agentDeviceModule`: config, defaults, cap check; loads `worker.ts` only when on                                                               |
| `worker.ts`                                                   | `createWorker`: supervisor, edge parts, capability, relay target, mount, hooks                                                                 |
| `host/agent-device-supervisor.ts`                             | Reap, start, watch, stop the daemon; availability state                                                                                        |
| `host/install.ts`                                             | `findAgentDevice`: command → install root → daemon entry                                                                                       |
| `host/health.ts`                                              | `NodeAgentDeviceHealthProbe`: `GET /health`, 5 s                                                                                               |
| `host/availability-findings.ts`                               | `agentDeviceFindings` for `simlock doctor`                                                                                                     |
| `host/upstream.ts`                                            | `AgentDeviceUpstream` port; `SupervisorAgentDeviceUpstream`                                                                                    |
| `host/host.ts`                                                | `AgentDeviceHost`: `@agent-device/proxy`, tenant, 2 GiB download cap                                                                           |
| `host/lease-end.ts`                                           | `ReleaseScopeRecord`, `AgentDeviceLeaseEnd` (lease-end participant)                                                                            |
| `front/front.ts`                                              | The mount: role check, routes, `/rpc` dispatch by call class                                                                                   |
| `front/request-rules.ts`                                      | Refusals and rewrites before anything is forwarded                                                                                             |
| `front/allocate.ts`, `front/heartbeat.ts`, `front/release.ts` | Lease calls ↔ simlock `lease.*`                                                                                                                |
| `front/renewals.ts`                                           | Renews the simlock lease while a command runs                                                                                                  |
| `front/front-map.ts`                                          | In-memory leases this front made, and who ended each                                                                                           |
| `front/devices-filter.ts`, `front/token-devices.ts`           | `devices` cut to the token's leases                                                                                                            |
| `front/host-link.ts`                                          | `HostLink` port (`stillHeld`: gateway only, a lease its `lease.list` omits is ended only when the index lost it); `InProcessHostLink` (worker) |
| `front/relay-host-link.ts`                                    | `RelayHostLink` (gateway); `FleetPort`                                                                                                         |
| `front/edge-parts.ts`                                         | Front parts, dispose and cancel steps, `createAgentDeviceFront`                                                                                |
| `gateway.ts`                                                  | Gateway side: `FleetPort` from the gateway context, the mount, `beforeDrain`                                                                   |
| `shared/`                                                     | Paths, routes, RPC reader, replies, compatibility, daemon env, release scope                                                                   |
| `testing.ts`                                                  | `FakeAgentDevice` (in-memory daemon), `FakeAgentDeviceHealth`                                                                                  |

## How it works

Supervisor start (`AgentDeviceSupervisor.start`, at daemon start):

1. Reap — pid from `<data dir>/agent-device-daemon.json`, else the state dir's `daemon.json`.
   Signal only if `ps` args end in `--simlock-home=<data dir>`; SIGTERM, check again, SIGKILL.
2. Find — `capabilities.agent-device.command` (`agent-device`) on `PATH` or as a path; `package.json`
   names `agent-device`; a daemon entry under `dist/src`. Never downloads.
3. Check — `--version` ≥ 0.21.28 (a prerelease of it is older); Node ≥ 22.12.0 (`shared/compatibility.ts`).
4. Prepare — state dir `<data dir>/agent-device` (0700, ours), policy file denying
   `boot`, `shutdown`, `device-shutdown`; env from `agentDeviceDaemonEnvironment` plus
   every driver's lease env (iOS device set mapped; no-iOS and no-Android sentinels).
5. Spawn `node <entry> --simlock-home=<data dir>`; write the pid record.
6. Ready — `daemon.json` names our pid → port listens → `/health` says
   `agent-device-daemon`, RPC protocol 2. Then `running`, generation + 1.
7. Exit — after ≥ 60 s running: start again now. Sooner: `unavailable`, retry in 30 s.
8. Stop — SIGTERM, SIGKILL, remove the record; a survivor keeps its record.

Availability: `off` | `starting` | `running` | `unavailable` (`not-found`, `not-agent-device`,
`wrong-version`, `state-dir`, `start-failed`). Only `start-failed` retries; the rest need a
daemon restart. Read by `agentDeviceFindings` (doctor) and `agentDeviceCapabilitySource`
(the `agent-device` capability in `status.get`). Unavailable: every route answers why.

Front (`createFront`, prefix `agent-device`):

1. Token checked by the http app. Role not `agent` → 403. Gateway: `adoptable` leases
   rebuilt into the map first.
2. Non-RPC: a fixed route list (`shared/routes.ts`), else 404. `/health` answers 200 even
   when unavailable.
3. `/rpc`: body ≤ 1 MiB, one JSON-RPC request; only `command` and `lease.*` methods, as
   agent-device's proxy takes no other from a tenant; `classifyCall` → allocate, heartbeat,
   release, command, or refused `wrapped-lease`.
4. `checkRequest`: iOS/Android only; no device selector but the leased one; no device
   set or allowlist; `install` only from an upload; `devices` alone, not streamed.
5. Allocate → `lease.request` (`front/allocate.ts`), see flow.
6. Heartbeat → forwarded with `ttlMs` raised to the ceiling; on success `renewLease`
   (`lease.renew` only if it moves the deadline; a gateway list that trails the grant and omits the lease still relays agent-device's reply). agent-device says gone → `lease.release`,
   reply "ended by simlock".
7. Release → forwarded; on success `lease.release`; map marks it ended by `agent`.
8. Command on a lease → `Renewals.begin`: renew every TTL/3 until the body ends,
   capped at `lease.maxTtlMs`. A reply naming `endedLeases` (in `data`, `error.details`, a streamed `type: "response"` line, or a
   batch's `data`) → `front/ended.ts` ends each simlock lease this token holds, as a release does.

Host (`AgentDeviceHost.forward`): one proxy per daemon generation. Tags the request,
and `authenticate` sets tenant = requester id, overwriting the client's. Rewrites
`/v1/agent-device` → `/agent-device`. Download: `Content-Length` > 2 GiB → 413 before
any byte; no length → counted, errors past 2 GiB.

Lease end: `ReleaseScopeRecord` reads each allocate reply's scope (tenant, run id, …)
through the proxy's upstream fetch. `AgentDeviceLeaseEnd.leaseEnded` waits for a
running allocate or release, then sends `agent_device.lease.release` with that scope,
under leasing's signal (`lease.endWaitMs`).

## Flow: agent on a worker

1. CLI `open` → `POST /v1/agent-device/rpc` `agent_device.lease.allocate` with its lease id.
2. Front refuses a non-plain lease, no `--platform`, a bad `ttlMs`, no lease id, `physical: true`, or a `--target` it does not map.
3. `lease.request`: `leaseId` = `requesterId` = the CLI's lease id; `--device` → model,
   `--target` → class, `--os` → `osVersion`, `--image-tag` → `imageTag`; TTL = sent, capped by `capabilities.agent-device.leaseTtlCapMs`, at least 5 s;
   queue wait 330 s. CLI hangs up → `lease.cancel`, retried every 1 s.
4. Grant → allocate forwarded with the device address (`udid`/`serial`), no
   `device`/`deviceKey`/`target`/`osVersion`/`imageTag` (commands lose both keys too), `ttlMs` = max(24 h, 2 × `lease.maxTtlMs`).
5. agent-device error → simlock lease released. Success → front map entry; reply relayed with `data.lease.device` `{ model, osVersion, imageTag? }` added from the grant.
6. Commands carry the lease id; rules check, renewals run, `devices` filtered.
7. Release → agent-device first, then `lease.release` → reclaim; lease-end finds no scope left.

## Flow: through a gateway

1. Gateway front runs the same rules; its link is `RelayHostLink`.
2. Allocate's `lease.request` adds `requires: ["agent-device"]`; the gateway places it on
   a worker whose capability is available.
3. Every later call is relayed to the lease's worker (`FleetPort.relay` → `GatewayRelay`,
   target `agent-device`) with tenant `gw.<gateway instance id>.<principal>`, cut to 128
   chars with a hash. A lease not the token's → 403. No lease: only `GET /health`.
4. Worker: `agentDeviceRelayTarget` → `InProcessHostLink` → host, requester = tenant.
   No front rules run on the worker.
5. Worker unreachable → "try again" reply; a command so answered ends its renewal
   reference without releasing the lease or ending worker work. Other live commands
   keep their references; the last reference ends with one final renewal attempt.
   A dropped lease is still routed for the gateway's `lease.maxTtlMs`;
   for 60 s after gateway start an unknown lease is unreachable.

## State and timers

| What                                           | Value                           | Key                                       |
| ---------------------------------------------- | ------------------------------- | ----------------------------------------- |
| Ready wait / health read / `--version`         | 15 s / 5 s / 10 s               | none                                      |
| Start retry; stable run before instant restart | 30 s; 60 s                      | none                                      |
| Stop grace                                     | SIGTERM 10 s, SIGKILL 2 s       | none                                      |
| Allocate queue wait                            | 330 s                           | none                                      |
| Lease TTL cap, floor                           | unset, 5 s                      | `capabilities.agent-device.leaseTtlCapMs` |
| agent-device lease ceiling                     | max(24 h, 2 × `lease.maxTtlMs`) | `lease.maxTtlMs`                          |
| Renewal tick                                   | TTL / 3                         | lease TTL                                 |
| Download cap; `/rpc` body                      | 2 GiB; 1 MiB                    | none                                      |

Disk: `<data dir>/agent-device/` (agent-device's own files) and the pid record. Front map,
renewals and release scopes: memory only.

## Rules

- The simlock lease is the only clock; an agent-device lease never outlives it.
- A pid is signalled only after the `--simlock-home` marker matches.
- The edge names no gateway type; the gateway side builds `FleetPort` from its gateway context.
- A daemon stop cancels waiting allocates (`cancelWaitingAllocates`) and stops renewals.
- Tests: `edge.test.ts`, `gateway-front.test.ts`, `front/*.test.ts`, `host/*.test.ts`.

## Known gaps

- **A daemon restart loses agent-device leases.** The next heartbeat answers ended by
  simlock and the simlock lease is released.
- **Agents sharing a token share a tenant**, and see each other's sessions.

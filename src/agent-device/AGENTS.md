# Agent-device edge

Does: runs two agent-device daemons per worker (the simulator daemon over Simlock's simulator set, the phone daemon beside it with no set) and serves the agent-device CLI at `/v1/agent-device/*`, one simlock lease per agent-device lease.
Entry: `index.ts` → `agentDeviceModule`. The front parts live in `front/edge-parts.ts` (`createGatewayAgentDeviceFrontParts`, `createAgentDeviceFront`, `disposeAgentDeviceEdge`, `cancelWaitingAllocates`). The gateway half is `gateway.ts` (`createGateway`, builds the `FleetPort` from the gateway context); the worker half is `worker.ts` (`createAgentDeviceEdgeParts`, builds one `AgentDeviceSupervisor` per role). The module host loads both.
Uses: ports, auth (`Identity`), http (session, errors), contract types, core and leasing types. Never imports: gateway, drivers, `fs`, `child_process`.
Imported by: the module registry (`index.ts` only); `daemon/main.ts` imports nothing from it (tests may use `testing.ts`). Pinned in `lint-rules.test.ts`.
On unless `capabilities.agent-device.enabled` is set false, on a standalone worker (`definition.ts` declares `enabledByDefault: "standalone-worker"`); off on a joined worker and a gateway unless set true. Off: nothing mounted, no daemon. When on only by default and the command is not found, the capability reads `off` and `agentDeviceFindings` says nothing (`isAbsentByDefault`); every other trouble, and a not-found with `enabled: true` set, stays `unavailable` with its finding.

## Files

| File                                                          | Role                                                                                                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition.ts`                                               | `agentDeviceModule`: config, defaults, cap check, `localProfile` (file name, token label, `render`); loads `worker.ts` only when on                                                    |
| `worker.ts`                                                   | `createWorker`: both supervisors, edge parts, capability, relay target, mount, hooks                                                                                                   |
| `host/agent-device-supervisor.ts`                             | Reap, start, watch, stop one role's daemon (`simulators` or `phones`); availability state                                                                                              |
| `host/install.ts`                                             | `findAgentDevice`: command → install root → daemon entry                                                                                                                               |
| `host/health.ts`                                              | `NodeAgentDeviceHealthProbe`: `GET /health`, 5 s                                                                                                                                       |
| `host/availability-findings.ts`                               | `agentDeviceFindings` for `simlock doctor`; a phone daemon's message starts `phone daemon: `                                                                                           |
| `host/upstream.ts`                                            | `AgentDeviceUpstream` port; `SupervisorAgentDeviceUpstream`                                                                                                                            |
| `host/host.ts`                                                | `AgentDeviceHost`: `@agent-device/proxy`, tenant, 2 GiB download cap                                                                                                                   |
| `host/lease-end.ts`                                           | `ReleaseScopeRecord`, `AgentDeviceLeaseEnd` (lease-end participant, one per daemon)                                                                                                    |
| `front/front.ts`                                              | The mount: role check, routes, `/rpc` dispatch by call class                                                                                                                           |
| `front/request-rules.ts`                                      | Refusals and rewrites before anything is forwarded                                                                                                                                     |
| `front/allocate.ts`, `front/heartbeat.ts`, `front/release.ts` | Lease calls ↔ simlock `lease.*`                                                                                                                                                        |
| `front/renewals.ts`                                           | Renews the simlock lease while a command runs                                                                                                                                          |
| `front/front-map.ts`                                          | In-memory leases this front made, and who ended each                                                                                                                                   |
| `front/devices-filter.ts`, `front/token-devices.ts`           | `devices` cut to the token's leases                                                                                                                                                    |
| `front/host-link.ts`                                          | `HostLink` port (`stillHeld`: gateway only, a lease its `lease.list` omits is ended only when the index lost it); `RoutedHostLink` (worker: one host per daemon, a lease → daemon map) |
| `front/relay-host-link.ts`                                    | `RelayHostLink` (gateway); `FleetPort`                                                                                                                                                 |
| `front/edge-parts.ts`                                         | Front parts, dispose and cancel steps, `createAgentDeviceFront`                                                                                                                        |
| `gateway.ts`                                                  | Gateway side: `FleetPort` from the gateway context, the mount, `beforeDrain`                                                                                                           |
| `shared/`                                                     | Paths, routes, RPC reader, replies, compatibility, daemon env, release scope                                                                                                           |
| `testing.ts`                                                  | `FakeAgentDevice` (in-memory daemon), `FakeAgentDeviceHealth`                                                                                                                          |

## How it works

A worker runs two supervisors, one per role. `simulators`: state dir `<data dir>/agent-device`,
record `agent-device-daemon.json`, marker `--simlock-home=<data dir>`. `phones`: state dir
`agent-device-phones`, record `agent-device-phones-daemon.json`, marker adds `--simlock-role=phones`;
its env has no simulator set or driver lease key, `ANDROID_ADB_SERVER_PORT=5037`, the
`AGENT_DEVICE_IOS_*` signing keys (`capabilities.agent-device.ios.*`; `teamId` and `bundleId` suffice, `provisioningProfile` and `signingIdentity` are for manual signing only), and the no-iOS and
no-Android sentinels when a platform is off. It starts once the simulator daemon's start has
settled, never awaited. The capability follows the simulator daemon; doctor lists a finding per
daemon. `RoutedHostLink` sends a physical allocate (its `serial`/`udid` is an enrolled phone's id) and every later call for that lease to the phone daemon, everything else to the simulator daemon; a phone daemon that is not running answers `phone daemon: <message>`. Each daemon has its own `ReleaseScopeRecord` and `AgentDeviceLeaseEnd`; the link forgets a lease when it ends.

Supervisor start (`AgentDeviceSupervisor.start`, at daemon start), per role:

1. Reap — pid from the role's record, else the state dir's `daemon.json`.
   Signal only if `ps` args end in the role's marker; SIGTERM, check again, SIGKILL.
2. Find — `capabilities.agent-device.command` (`agent-device`) on `PATH` or as a path; `package.json`
   names `agent-device`; a daemon entry under `dist/src`. Never downloads.
3. Check — `--version` ≥ 0.21.28 (a prerelease of it is older); Node ≥ 22.12.0 (`shared/compatibility.ts`).
4. Prepare — state dir `<data dir>/agent-device` (0700, ours), policy file denying
   `boot`, `shutdown`, `device-shutdown`; env from `agentDeviceDaemonEnvironment` plus
   every driver's lease env (iOS device set mapped; no-iOS and no-Android sentinels).
5. Spawn `node <entry> <marker>`; write the pid record.
6. Ready — `daemon.json` names our pid → port listens → `/health` says
   `agent-device-daemon`, RPC protocol 2. Then `running`, generation + 1.
7. Exit — after ≥ 60 s running: start again now. Sooner: `unavailable`, retry in 30 s.
8. Stop — SIGTERM, SIGKILL, remove the record; a survivor keeps its record.

Availability: `off` | `starting` | `running` | `unavailable` (`not-found`, `not-agent-device`, `wrong-version`, `state-dir`, `start-failed`). Only `start-failed` retries; the rest need a daemon restart. Read by `agentDeviceFindings` (doctor) and `agentDeviceCapabilitySource`
(the `agent-device` capability in `status.get`). Unavailable: every route answers why.

Front (`createFront`, prefix `agent-device`):

1. Token checked by the http app. Role not `agent` → 403. Gateway: `adoptable` leases
   rebuilt into the map first.
2. Non-RPC: a fixed route list (`shared/routes.ts`), else 404. `/health` answers 200 even when unavailable.
3. `/rpc`: body ≤ 1 MiB, one JSON-RPC request; only `command` and `lease.*` methods, as agent-device's proxy takes no other from a tenant; `classifyCall` → allocate, heartbeat,
   release, command, or refused `wrapped-lease`.
4. `checkRequest`: iOS/Android only; no device selector but the leased one; no device
   set or allowlist; `install` only from an upload; `devices` alone, not streamed.
   A rule that needs a leased device's name (`--device`) reads it once per lease from agent-device's `devices` list (`namedTokenDevices`).
5. Allocate → `lease.request` (`front/allocate.ts`), see flow.
6. Heartbeat → forwarded with `ttlMs` raised to the ceiling; on success `renewLease`
   (`lease.renew` only if it moves the deadline; a gateway list that trails the grant and omits the lease still relays agent-device's reply). agent-device says gone → `lease.release`, reply "ended by simlock".
7. Release → forwarded; on success `lease.release`; map marks it ended by `agent`.
8. Command on a lease → `Renewals.begin`: renew every TTL/3 until the body ends,
   capped at `lease.maxTtlMs`. A reply naming `endedLeases` (in `data`, `error.details`, a streamed `type: "response"` line, or a
   batch's `data`) → `front/ended.ts` ends each simlock lease this token holds, as a release does.

Host (`AgentDeviceHost.forward`): one proxy per daemon generation. Tags the request, and `authenticate` sets tenant = requester id, overwriting the client's. Rewrites `/v1/agent-device` → `/agent-device`. Download: `Content-Length` > 2 GiB → 413 before
any byte; no length → counted, errors past 2 GiB.

Lease end: `ReleaseScopeRecord` reads each allocate reply's scope (tenant, run id, …)
through the proxy's upstream fetch. `AgentDeviceLeaseEnd.leaseEnded` waits for a
running allocate or release, then sends `agent_device.lease.release` with that scope,
under leasing's signal (`lease.endWaitMs`).

## Flow: agent on a worker

1. CLI `open` → `POST /v1/agent-device/rpc` `agent_device.lease.allocate` with its lease id.
2. Front refuses a non-plain lease, no `--platform`, a bad `ttlMs`, no lease id, a `physical` that is not a boolean, or a `--target` it does not map.
3. `lease.request`: `leaseId` = `requesterId` = the CLI's lease id; `--device` → model,
   `--target` → class, `--os` → `osVersion`, `--image-tag` → `imageTag`, `physical: true` → `physical: true` (Simlock picks an enrolled phone); TTL = sent, capped by `capabilities.agent-device.leaseTtlCapMs`, at least 5 s;
   queue wait 330 s. CLI hangs up → `lease.cancel`, retried every 1 s.
4. Grant → allocate forwarded with the device address (`udid`/`serial`; a phone's is its enrolled id), to the phone daemon for a phone and the simulator daemon otherwise (`RoutedHostLink`, which remembers each lease's daemon until the lease ends), no
   `device`/`deviceKey`/`target`/`osVersion`/`imageTag`/`physical` (commands lose both keys too), `ttlMs` = max(24 h, 2 × `lease.maxTtlMs`).
5. agent-device error → simlock lease released. Success → front map entry; reply relayed with `data.lease.device` `{ model, osVersion, physical, imageTag? }` added from the grant.
6. Commands carry the lease id; rules check, renewals run, `devices` filtered.
7. Release → agent-device first, then `lease.release` → reclaim; lease-end finds no scope left.

## Flow: through a gateway

1. Gateway front runs the same rules; its link is `RelayHostLink`.
2. Allocate's `lease.request` adds `requires: ["agent-device"]`; the gateway places it on
   a worker whose capability is available.
3. Every later call is relayed to the lease's worker (`FleetPort.relay` → `GatewayRelay`,
   target `agent-device`) with tenant `gw.<gateway instance id>.<principal>`, cut to 128
   chars with a hash. A lease not the token's → 403. No lease: only `GET /health`.
4. Worker: `agentDeviceRelayTarget` → `RoutedHostLink` (the lease id picks the phone daemon or the simulator daemon) → host, requester = tenant.
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

Disk: `<data dir>/agent-device/` and `<data dir>/agent-device-phones/` (agent-device's own files) and the two pid records. Front map,
renewals and release scopes: memory only.

Local profile: a standalone worker with HTTP and this module on keeps `<data dir>/agent-device-profile.json` (0600) so an agent on the same Mac connects with `agent-device connect --remote-config <file>` and no token of its own ([ADR 0046](../../docs/internal/adr/0046-a-standalone-worker-serves-agent-device-by-default-with-a-private-profile.md)). `definition.ts` declares the file as plain data; the module host writes it at each start, reuses the one `agent`-role token labelled `agent-device on this Mac` (so an agent's saved connection stays valid), revokes other tokens with that label, and deletes the file and revokes the token when HTTP or the module is off. No worker code runs for it.

## Rules

- The simlock lease is the only clock; an agent-device lease never outlives it.
- A pid is signalled only after its role's whole marker matches (`--simlock-home`, and `--simlock-role=phones` for the phone daemon).
- The edge names no gateway type; the gateway side builds `FleetPort` from its gateway context.
- A daemon stop cancels waiting allocates (`cancelWaitingAllocates`) and stops renewals.
- Tests: `edge.test.ts`, `gateway-front.test.ts`, `front/*.test.ts`, `host/*.test.ts`.

## Known gaps

- **A daemon restart loses agent-device leases.** The next heartbeat answers ended by
  simlock and the simlock lease is released. A call on a phone lease drops the client's `x-agent-device-instance` and `x-agent-device-upstream-instance` pins (`front/host-link.ts`), which name the simulator daemon the client read `/health` from; so this holds for the phone daemon too.
- **Agents sharing a token share a tenant**, and see each other's sessions.

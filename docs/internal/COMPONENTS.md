# Components

One row per component, with what it owns and what it deliberately leaves to
someone else. This is the inventory [ARCHITECTURE.md](ARCHITECTURE.md)
narrates; read that for the why and the flows, read this to answer "who owns
X". It describes the code on `main` today. Where an ADR marked _Accepted —
not yet implemented_ moves a responsibility, the ADR is the target and this
table catches up with the PR that implements it.

A change that adds, renames, splits or moves a component updates its row in
the same change (architecture rule 13, always-in-scope item 1). A component
that is a directory exposes its surface through its `index.ts` (architecture
rule 14); a single-file component's surface is what the file exports.

## Frontends

| Component | Where | Owns | Does not |
|---|---|---|---|
| CLI | `src/cli/` | The operator command surface over `simlock/client` and `simlock/admin`: argument parsing, rendering, the lease connection it holds while alive, `simlock simctl` / `simlock adb` passthrough, log following. | Decide anything: no capacity, queue or device logic (architecture rule 8). |
| stdio MCP server | `src/mcp/` | One agent session over stdin/stdout (`McpSession`): the lease and release tools, the renew timer, relaying progress, lazy reconnect to a listening daemon. | Cache lease state: `lease_status` is a `lease.list` call. Reconnect on a version mismatch. |
| HTTP frontend | `src/http/` | Routing plus a bearer-token-to-session adapter (`app.ts`, `auth.ts`): calls the daemon's dispatcher in process, serves SSE streams, tracks lease requests as resources (`LeaseRequestTracker`), buffers per-lease health notices (`LeaseNoticeBuffer`), relays exec output (`OutputRelay`), stores token hashes (`TokenStore`), and binds the listener (`HttpGateway`). | Role checks or ownership: those run in the shared `Dispatcher`. |
| Web console | `ui/` | A React app served at every path outside `/v1`; reads `/v1` only, through the live layer that refetches on the event stream. | Touch the API's auth or request log; hold state the daemon does not. |
| Typed client | `src/client/`, `src/admin/`, `src/simlock-client/` | `simlock/client` and `simlock/admin`: the supported programmatic surface, one connection, typed operations over the wire (`SimlockWire`). | Reconnect or retry; enforce roles client side. |
| Lease policy | `src/lease-policy/` | The client-side renew timer: one third of the TTL, release on exit, parent death or a signal. | Hold anything on the daemon: the connection holds nothing (ADR 0004). |
| Agent identity | `src/agent-identity/` | The default requester id a frontend declares when the caller names none. One function for the CLI and MCP. | Reach the daemon: it only sees the id it is sent. |
| Daemon protocol | `src/daemon-protocol/` | Newline-delimited JSON framing and the single protocol version derived from the contract's range. | Declare a version of its own. |

## Contract

| Component | Where | Owns | Does not |
|---|---|---|---|
| Contract | `src/contract/` | The one typed daemon contract (ADR 0003): operation declarations, input and output schemas, roles, the error-code union, pushes, the protocol version range, the worker view shape, the OS-range grammar, duration parsing. | Implement an operation; know which frontend or daemon mode is calling. |

## Daemon process

| Component | Where | Owns | Does not |
|---|---|---|---|
| Composition root | `src/daemon/main.ts` | Builds the real adapters once and wires drivers, ports, the engine or the gateway, and the frontends. | Keep state: all state lives in the daemon's components. |
| `DaemonServer` | `src/daemon/server.ts` | The unix-socket endpoint: the `hello` handshake, per-connection sessions, push routing, `daemon.stop`, the startup readiness gate, and serving uplink connections as ordinary connections. | Handle an operation itself: it builds one `Dispatcher` and hands every request to it. |
| `Dispatcher` | `src/daemon/dispatcher.ts` | One `dispatch()` for every transport: parse input, role check, `authorize` hook, park on readiness, call the handler, parse output. The handlers for a worker live here. | See a raw payload in a handler; serve `hello` or `daemon.stop`. |
| `DaemonEndpointHost` | `src/daemon/connection-host.ts` | Claiming the socket, recovering a stale entry, the listener lifecycle. | Anything after a connection is accepted. |
| `AdminSecretManager`, session resolver | `src/daemon/admin-secret.ts`, `src/daemon/session.ts` | The per-start admin secret, its hash and persistence; turning a credential into `{ principal, role }`. | Decide what a role may do. |
| `GatewayUplink` | `src/daemon/gateway-uplink.ts` | When a worker dials its gateway: one outbound connection, redialled with backoff, handed to `DaemonServer`. | What travels over the link. |
| `OwnerRoutedFactBus` | `src/daemon/owner-routed-facts.ts` | Re-emitting lease-scoped facts with the lease's owner attached, for pushes and HTTP notices. | Emit a business fact of its own. |

## Core: the lease engine

`LeaseEngine` (`src/core/lease-engine.ts`) is the composition root and facade
for everything in this table. It wires one `SerializedDecision`, one
`DeviceOperationClaims`, one `DriverCatalog`, the registry and the capacity
coordinator into the components below.

| Component | Where | Owns | Does not |
|---|---|---|---|
| `Registry` | `src/core/registry.ts` | Devices, leases, lease requests and component records, written through one commit to `state.json`; the device transition function's only caller; emits the post-commit device and lease facts. | Decide a transition: callers do, inside a decision section. |
| `SerializedDecision` | `src/core/serialized-decision.ts` | Serialising short read-decide-commit sections. | Hold driver work or other long I/O. |
| `DeviceOperationClaims` | `src/core/device-operation-claims.ts` | Exclusive per-device operation claims: boot, eviction, cleanup, nuke, reclaim. | Any lifecycle, cleanup or leasing policy. |
| `LeaseRequestBook` | `src/core/lease-request-book.ts` | The lease-request rules: store before queueing, answer a repeat under the same idempotency key, write a result once. Shared with the gateway over an in-memory store. | Queue or serve the request. |
| `WaitQueue` | `src/core/wait-queue.ts` | FIFO membership, timeouts, cancellation, progress, and settlement of pending requests. | Decide whether capacity exists or perform lease work. |
| `LeaseAcquisitionCoordinator` | `src/core/lease-acquisition-coordinator.ts` | Admission, resolving a request into a requirement and a create spec (class, OS range, default mode, image tag), driving plans to a grant, eviction by demand, maintenance fencing for nuke. Exposes the queue head's spec and the waiting requests, read only. | Choose which device: the planner does. Reclaim: the release side does. |
| `AcquisitionPlanner` | `src/core/acquisition-planner.ts` | The read-only plan for one request: grant a fitting ready device, boot a fitting shut-down one, evict an idle running device, provision, wait, or refuse. Takes capacity reservations and claims and hands them to the caller. | Perform any side effect. |
| `DeviceProvisioner` | `src/core/device-provisioner.ts` | Creating a device: the component-removal gate, the registry record, the driver's `provision`, readiness for the lease handoff. | Decide whether to provision. |
| `ManagedDeviceLifecycle` | `src/core/managed-device-lifecycle.ts` | Registry-owned device operations with a claim and a revalidation each: boot for a lease, shutdown, destroy, dispose, recover a leased device. Every driver verb on an existing device goes through here. | Decide when to run them. |
| `LeaseLifecycle` | `src/core/lease-lifecycle.ts` | Grant, renew, the registry half of a release, expiry scheduling through `LeaseExpiryScheduler`. | Reclaim; wake the queue. |
| `LeaseExpiryScheduler` | `src/core/lease-expiry-scheduler.ts` | TTL timers, delivered to the release coordinator. | Decide what expiry means. |
| `LeaseReleaseCoordinator` | `src/core/lease-release-coordinator.ts` | Release, release-all, expiry and device-lost as lease commands: the serialized commit, the backgrounded reclaim with its claim, the drain for nuke and daemon stop, maintenance admission. | Purge or decide warmth: it hands the released device to `WarmPoolCoordinator`. |
| `WarmPoolCoordinator` | `src/core/warm-pool-coordinator.ts` | After a release: the driver's reclaim, the keep-ready-or-shut-down decision with its rewarm boot, handing a failed purge to quarantine, deleting a spent `fresh` device, recovering an interrupted reclaim at startup. Reads the queue head's spec and capacity for the keep decision. | Fill the pool proactively or boot anything demand did not release. See IDEAS.md and the warm pool ADR when it lands. |
| Warm-pool policy | `src/core/warm-pool.ts` | LRU order and victim selection over idle devices, used by the planner's eviction and the startup converger. | Act. |
| `QuarantineCoordinator` | `src/core/quarantine-coordinator.ts` | The quarantine lifecycle: entry from a failed purge, a failed spent delete or a stalled transition; retry on backoff; give up by destroying. | Pick which devices are grantable: every grant path selects by exact state. |
| `CapacityCoordinator`, strategies, `CapacityObserver` | `src/core/capacity/` | Limits and the RAM budget behind a pluggable `CapacityStrategy` (`resource`, `fixed`); provisioning, running and boot reservations; the figures status and `capacity.changed` report. | Know about queueing, device selection, the registry or drivers. |
| `StartupConverger` | `src/core/startup-converger.ts` | The startup sequence, in order: settle open lease requests, restore TTL timers, recover interrupted reclaims, delete spent devices, re-arm quarantine, shut down excess ready devices by LRU. | Emit events: recovery and cleanup own their facts. Call a driver refused at discovery. |
| `CleanupReaper`, rules, `CleanupExecutor` | `src/core/reaper.ts`, `src/core/cleanup/`, `src/core/cleanup-executor.ts` | Pure idle rules (shutdown after T1, delete after T2, sooner under disk pressure) evaluated on a tick and on `lease.released`; the executor revalidates ownership, lease and state, then acts through the lifecycle. | Touch a leased or claimed device; know why a device is idle. |
| `NukeService`, `Nuke` | `src/core/nuke-service.ts`, `src/core/nuke.ts` | The operator reset: maintenance fencing, release-all, cancelling pending requests, registry-scoped shutdown or delete. | Address a driver device directly. |
| `LeaseHealthMonitor` | `src/core/lease-health-monitor.ts` | Observing leased devices on a tick, rebooting a crashed one under its lease, giving the lease up as `device-lost` when recovery is exhausted. | Touch an unleased device. |
| `Doctor` | `src/core/doctor.ts` | Findings: registry versus driver reality, provenance marks, stalled transitions, prerequisites, the slim advisory, remediation proposals. | Fix anything on its own except entering quarantine for a stalled transition. |
| `ComponentInstaller`, `DiskSpaceGuard` | `src/core/component-installer.ts`, `src/core/driver.ts` | The only caller of a driver's `installComponent` and `removeComponent` (ADR 0010): one queue per platform, the download policy, the timeout budget, the disk-space preflight shared across platforms, the removal gate device creation checks. | Decide a lease needs a download: the acquisition coordinator asks. |
| `DriverCatalog` | `src/core/driver-catalog.ts` | Platform-to-driver lookup, model preferences per class, catalog reads, passthrough resolution. | Platform behaviour. |
| `HostFactsReader` | `src/core/host-facts.ts` | The host facts status reports: OS from the port, tool versions from each driver, served from memory and re-read in the background. | Name a tool. |
| Catalog match | `src/core/catalog-match.ts` | Whether a catalog can serve a request: model or class, runtime, image tag. Shared with the gateway. | Pick a device. |
| Device roots, instance identity, config, domain | `src/core/device-root.ts`, `src/core/instance-identity.ts`, `src/core/config.ts`, `src/core/domain.ts` | Owned-root validation (ADR 0001); the daemon's instance id; config loading, defaults, validation and redaction; the device state machine, specs, requirements, `fits`, `sameSpec`, `mayBeGranted`. | Anything platform-specific. |

## Drivers

| Component | Where | Owns | Does not |
|---|---|---|---|
| `Driver` interface | `src/core/driver.ts` | The verbs the core speaks: `resolveSpec`, `provision`, `makeReady`, `reclaim`, `shutdown`, `destroy`, `estimate`, `listManaged`, `listCatalog`, component install and removal, passthrough, lease environment. | Carry platform concepts: addresses and driver data are opaque to the core. |
| iOS driver | `src/drivers/ios/` | `IosSimctlDriver`: every `simctl` call scoped to the owned device set, erase as the reclaim, the slim pass inside `makeReady`, the label list, runtime install, prerequisites. | Decide the default mode or anything about leases. |
| Android driver | `src/drivers/android/` | `AndroidDriver`: AVDs in the owned AVD home, Simlock's own adb server (`AdbServerSupervisor`, `AdbRegistrar`), the clean-baseline snapshot as the reclaim, device profiles, system-image install, prerequisites. | Same as iOS. |
| Installer process | `src/drivers/installer-process.ts` | Running a platform's installer command with streamed progress. | Decide whether to install. |
| `FakeDriver` | `src/core/fake-driver.ts`, exported from `src/core/testing.ts` | A scripted in-memory driver for the fast test lane and `SIMLOCK_DRIVERS_MODULE` setups. | Touch a real device. |

## Event bus

| Component | Where | Owns | Does not |
|---|---|---|---|
| `EventBus` | `src/bus/index.ts` | Typed post-commit business facts, their ids and sequence, subscribers isolated from emitters, the in-memory ring `simlock events` replays. | Carry a step of a transaction (architecture rule 5). |
| `EventHistory` | `src/bus/event-file.ts` | The event file: every fact on disk, rotation by size and retention, replay across a restart. | Stop an emitter when a write fails. |

## Gateway

A gateway runs `src/gateway/` in place of the lease engine. It imports no
driver and, from `src/core/`, only the queue, the request book, catalog
matching and the bus (ARCHITECTURE.md, "Boundaries").

| Component | Where | Owns | Does not |
|---|---|---|---|
| `GatewayService` | `src/gateway/service.ts` | Lifecycle: the uplink listener, one `WorkerLink` per worker, feeding the registry, the periodic tick that backstops refreshes and sweeps expired views. | Answer an operation or define a view. |
| `WorkerLink` | `src/gateway/worker-link.ts` | One worker's uplink from the gateway's side: the typed admin client over it, the reads on connect, refreshes on worker events, relaying worker events with the worker's id. | Decide what a view means. |
| `WorkerRegistry`, drain store | `src/gateway/worker-registry.ts`, `src/gateway/drain-store.ts` | What a worker view is and when it changes; the facts emitted as views change; the one persisted bit, the drained set. | Talk to a worker. |
| `FleetLeaseCoordinator`, `FleetQueue`, `FleetLeaseIndex` | `src/gateway/fleet-coordinator.ts`, `src/gateway/queue.ts`, `src/gateway/lease-index.ts` | Admission and the fleet-wide one-lease rule, the fleet FIFO, dispatch of each queued request to the worker routing picks with `noWait`, retry on a cannot-serve refusal, forwarding lease and exec calls, projecting worker leases as fleet leases. | Provision, evict, or hold a device opinion: a worker grants or refuses. |
| Routing | `src/gateway/routing.ts`, `src/gateway/routing/` | The pure routing policy: an ordered list of stages (`takes-requests`, `can-serve`, `healthy`, `idle-queue`, `warm-hit`, `free-slot`, `ram-budget`, `free-capacity`) over worker views, selected by `gateway.routing`. | Read anything but views; order stages from config. |
| `GatewayDispatcher` | `src/gateway/dispatcher.ts` | The second implementation of the contract's handlers (ADR 0005 §32): answered from the fleet, forwarded to one worker, or fanned out to all. | Define a second contract or role check. |
| Aggregate, component relay | `src/gateway/aggregate.ts`, `src/gateway/component-relay.ts` | The fleet expressed in one machine's shapes, as pure functions over views; asking every worker to install a component and collecting one outcome each. | Decide anything a worker decides. |
| `GatewayOwnerRoutedFacts` | `src/gateway/owner-routed-facts.ts` | The gateway's owner-attributed lease facts, from relayed worker events. | Emit a fact of its own. |

## Ports

Every external API the core and the daemon touch sits behind an interface in
`src/ports/`, each with a Node adapter and an in-memory fake (architecture
rule 9): `Clock`, `Filesystem`, `ProcessRunner` (and the logging wrapper),
`ProcessSupervisor`, `SystemStats`, `HostInfo`, `IdGenerator`, `IpcTransport`,
`Logger` and log sinks, `ParentWatch`, `TcpProbe`, `TokenSecrets`,
`DaemonLauncher`, the uplink transport and its WebSocket adapters, and the
path helpers.

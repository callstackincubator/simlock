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
| Link module | `src/link/` (surface: `index.ts`) | Wrapping one uplink transport connection (ADR 0028 §1-3): text messages passed through unchanged and ahead of bulk bytes, byte channels with credit, the envelope, the two-lane scheduler and the channel rules, the 64 channel limit and the waits it bounds (30 s accept, 60 s credit). Both uplink ends (the worker's and the gateway's) wrap their connection with it. | Know what a channel carries, or touch a socket (the transport port does). |
| Relay targets | `src/daemon/relay.ts` | A worker's `relayTargets` (capability name to a function that takes a `Request`, a tenant and a lease id and answers a `Response`), and per uplink connection the relays it carries: the request body read from the relay's byte channel, the head sent as a `relay-head` push and the response body written to the channel, cancel and abort on close. `src/daemon/main.ts` registers the `agent-device` target through the option. | Name a target: the core knows none; modules register through the option. |
| `OwnerRoutedFactBus` | `src/daemon/owner-routed-facts.ts` | Re-emitting lease-scoped facts with the lease's owner attached, for pushes and HTTP notices. | Emit a business fact of its own. |

## Core: device management

`createCore` (`src/core/create-core.ts`) is the composition root for everything in
this table. It wires one `SerializedDecision`, one `DeviceOperationClaims`, one
`DriverCatalog`, the registry and the capacity coordinator into the components
below, and returns them with a `connect` step. Core never imports leasing
(ADR 0018 §2): where it needs something from leasing it declares a port, and
the daemon fills it by calling `connect` with what `createLeasing` built. A core
service called before `connect` fails with an error naming the missing port.
The ports are nuke's release-all during maintenance, the lease expiry doctor
uses on a lapsed lease, the kick the reclaim coordinator and cleanup give
acquisition once a device is back, and the demand and maintenance flag the warm
pool reads from acquisition.

| Component | Where | Owns | Does not |
|---|---|---|---|
| `Registry` | `src/core/registry.ts` | Devices (virtual in `devices`, physical in `physicalDevices`, ADR 0022 §1), leases, lease requests and component records, written through one commit to `state.json`; the one virtual read, `snapshot.virtualDevices`; the device transition function's only caller; emits the post-commit device and lease facts. | Decide a transition: callers do, inside a decision section. |
| `SerializedDecision` | `src/core/serialized-decision.ts` | Serialising short read-decide-commit sections. | Hold driver work or other long I/O. |
| `DeviceOperationClaims` | `src/core/device-operation-claims.ts` | Exclusive per-device operation claims: boot, eviction, cleanup, nuke, recovery, reclaim, enrollment, grant (a physical device's presence read). | Any lifecycle, cleanup or leasing policy. |
| `PhysicalEnrollment` | `src/core/physical-enrollment.ts` | `device add` and `device remove` (ADR 0022 §2): refusing Simlock's own simulators and emulators and a device enrolled on the other platform (wording those refusals and the busy refusal itself), relaying the driver's read and its refusals, finding the one record a canonical ID has, taking the `enrollment` claim from the second read to the rewrite, and the busy check `add` and `remove` share. Built by `createCore` as `core.enrollment`. | Read a device or word the driver's refusals (the driver does); write a record (the registry does); run on a gateway. |
| `readPhysicalPresence` | `src/core/physical-presence.ts` | The one reading of a driver's `listPresentPhysical`: present or not present per ID, an ID with no entry not present, asking only for the IDs given; remembers the latest answer per ID (`latestPresence`), which status and list read as a physical device's `presence`. | Decide what a rejection means: each caller does. |
| `DeviceProvisioner` | `src/core/device-provisioner.ts` | Creating a device: the component-removal gate, the registry record, the driver's `provision`, readiness for the lease handoff. | Decide whether to provision. |
| `ManagedDeviceLifecycle` | `src/core/managed-device-lifecycle.ts` | Registry-owned device operations with a claim and a revalidation each: boot for a lease, boot back to warm, shutdown, destroy, dispose, recover a leased device. Every driver verb on an existing device goes through here. | Decide when to run them. |
| `ReclaimCoordinator` | `src/core/reclaim-coordinator.ts` | After a release: the driver's reclaim (for a physical device an uninstall of the apps off its enrollment list, committing `ready` and the apps it found missing), committing the state it returns (`shutdown` on iOS, `ready` on Android) and waking the queue, handing a failed purge to quarantine (a physical device read not present goes `absent` instead), returning an `absent` physical device that reappears through a reclaim, deleting a spent `fresh` device, recovering an interrupted reclaim at startup (a shutdown; for a device whose wipe a start put off, the full reclaim started in the background under a claim, and `settle` for a graceful stop). | Decide whether a device stays warm, boot anything, or read capacity or the queue. The warm pool (`src/core/warm-pool/`, ADR 0017) does. |
| `WarmPool`, `policy.ts` | `src/core/warm-pool/` | What stays warm: one pass at a time after the bus facts that change the budget and a 30 s tick; the pure policy proposes shutdowns over the budget (LRU, never a device that serves a waiting request) and boots for a waiting request or a recently released device with room; `warmPool.enabled`, `warmPool.reserveRunning` (running slots idle devices may not fill) and their config; `warmPool.targets`: resolves each target through the acquisition coordinator's `resolve`, boots or creates devices of that kind up to `maxConcurrentBoots` at once (`retry.ts` remembers failures), reports what each kind of device is short of (`figures()`, which status, doctor and the console read, and the `warm-pool.target-missed` event on each report's edge into short, kept per configured target), names the targeted devices the idle shutdown timer leaves alone, and shuts down a never-leased device no target keeps. | Reclaim; grant; decide the running limit (`capacity/`); resolve a request into a spec (the coordinator does); act on a device without revalidating it (it goes through `ManagedDeviceLifecycle` or `DeviceProvisioner`). |
| Idle order | `src/core/idle-order.ts` | LRU order and victim selection over idle devices, used by the planner's eviction and the warm pool. | Act. |
| `QuarantineCoordinator` | `src/core/quarantine-coordinator.ts` | The quarantine lifecycle: entry from a failed purge, a failed spent delete or a stalled transition; retry on backoff under the device's `reclaim` claim, waiting a backoff when the claim is held; give up by destroying a virtual device, or by unenrolling a physical one, which is never destroyed. | Pick which devices are grantable: every grant path selects by exact state. |
| `CapacityCoordinator`, strategies, `CapacityObserver` | `src/core/capacity/` | Limits and the RAM budget behind a pluggable `CapacityStrategy` (`resource`, `fixed`); provisioning, running and boot reservations; the figures status and `capacity.changed` report. | Know about queueing, device selection, the registry or drivers. |
| `readStartup`, `StartupRead` | `src/core/startup-read.ts` | Startup's one read of the machine: `listManaged` once per driver, side by side, each bounded by a fixed 60-second limit on the injected clock; a platform with no driver, or whose listing throws or passes the limit, is unreadable and left out. Doctor's startup pass, leasing's reconciler and device convergence all take it. | Throw, or fail startup for one platform. Read a second time. |
| `StartupConverger` | `src/core/startup-converger.ts` | The device steps of startup, in order: re-arm quarantine, recover interrupted reclaims, delete spent devices. Leasing's reconciler runs before it. | Emit events: recovery and cleanup own their facts. Act on a device whose platform the startup read could not list. |
| `CleanupReaper`, rules, `CleanupExecutor` | `src/core/reaper.ts`, `src/core/cleanup/` (surface: `index.ts`), `src/core/cleanup-executor.ts` | Pure idle rules (shutdown after T1 except for a device a warm target keeps, delete after T2 counted from `shutdownAt` for a never-leased device, sooner under disk pressure) evaluated on a tick and on `lease.released`; the executor revalidates ownership, lease and state, then acts through the lifecycle. | Touch a leased or claimed device; know why a device is idle. |
| `NukeService`, `Nuke` | `src/core/nuke-service.ts`, `src/core/nuke.ts` | The operator reset: maintenance fencing, release-all, cancelling pending requests, registry-scoped shutdown or delete. | Address a driver device directly. |
| `Doctor` | `src/core/doctor.ts` | Findings: registry versus driver reality (the startup read at a daemon start, a fresh listing otherwise), provenance marks, stalled transitions, prerequisites, the slim advisory, remediation proposals. | Fix anything on its own except entering quarantine for a stalled transition. |
| `ComponentInstaller`, `DiskSpaceGuard` | `src/core/component-installer.ts`, `src/core/driver.ts` | The only caller of a driver's `installComponent` and `removeComponent` (ADR 0010): one queue per platform, the download policy, the timeout budget, the disk-space preflight shared across platforms, the removal gate device creation checks. | Decide a lease needs a download: the acquisition coordinator asks. |
| `DriverCatalog` | `src/core/driver-catalog.ts` | Platform-to-driver lookup, model preferences per class, catalog reads, passthrough resolution. | Platform behaviour. |
| `HostFactsReader` | `src/core/host-facts.ts` | The host facts status reports: OS from the port, tool versions from each driver, served from memory and re-read in the background. | Name a tool. |
| Catalog match | `src/core/catalog-match.ts` | Whether a catalog can serve a request: model or class, runtime, image tag. Shared with the gateway. | Pick a device. |
| Device roots, instance identity, config, domain | `src/core/device-root.ts`, `src/core/instance-identity.ts`, `src/core/config.ts`, `src/core/domain.ts` | Owned-root validation (ADR 0001); the daemon's instance id; config loading, defaults, validation and redaction; the device state machine, specs, requirements, `fits`, `fitsPhysical` and `noPhysicalMatch` (the one match function and the one "nothing could match" message for a physical request), `sameSpec`, `mayBeGranted`. | Anything platform-specific. |

## Leasing

`src/leasing/` holds every lease rule and is entered only through
`src/leasing/index.ts` (ADR 0018). `createLeasing({ core, ... })` builds it on top
of `createCore`'s services. A gateway imports from its index the request book,
the in-memory store, the wait queue, their errors and their types, and nothing
else. Leasing's `testing.ts` holds the wiring other modules' tests build both
modules with.

| Component | Where | Owns | Does not |
|---|---|---|---|
| `createLeasing`, `LeaseStartup` | `src/leasing/create-leasing.ts`, `src/leasing/lease-startup.ts` | The composition root for leasing, built on `createCore`'s services: it wires the health monitor or leaves it out, and builds the ports core needs as `corePorts`, which the daemon hands to `core.connect`. The lease half of startup, around core's read: settle every request the previous process left open as failed, then, against the startup read, end the leases whose device is not running and restore the TTL timer of the rest. | Run a device operation: it calls core's services. |
| `LeaseReconciler` | `src/leasing/lease-reconciler.ts` | Judging every lease on a virtual device on disk against the startup read by the device's registry `driverDeviceId`, and handing each lease whose device is not running to the release coordinator as `device-lost` or `expired` with the device outcome the read implies (reclaim, wait, missing). | Reclaim, mark a device missing or emit an event itself: the release path owns all three. |
| `LeaseRequestBook` | `src/leasing/lease-request-book.ts` | The lease-request rules: store before queueing, answer a repeat under the same idempotency key and `leaseId`, write a result once (a daemon's grant is written with its lease, in one commit), and say whether a request still open holds a caller-chosen lease ID. Shared with the gateway over an in-memory store. | Queue or serve the request. |
| `WaitQueue` | `src/leasing/wait-queue.ts` | FIFO membership in two lines (virtual and physical, one arrival order, counted per line), timeouts, cancellation, progress, and settlement of pending requests. | Decide whether capacity exists or perform lease work. |
| `LeaseAcquisitionCoordinator` | `src/leasing/lease-acquisition-coordinator.ts` | Admission (the one-lease-per-requester check, then the lease-ID clash check), resolving a request into a requirement and a create spec (class, OS range, default mode, image tag), driving plans to a grant, a physical request's could-match check and presence read under a `grant` claim, eviction by demand, maintenance fencing for nuke. Exposes the queue head's spec, the waiting requests and the demand the warm pool reads (`waitingDemand`), read only, and `resolve`, which turns a request into its spec with downloads off for the warm pool's targets. | Choose which device: the planner does. Reclaim: the release side does. |
| `AcquisitionPlanner` | `src/leasing/acquisition-planner.ts` | The read-only plan for one request (for a physical request: the first fitting ready enrolled device that nothing holds, never a boot, provision or eviction): grant a fitting ready device, wait for a fitting one the warm pool is booting, boot a fitting shut-down one, evict an idle running device, provision, wait, or refuse. Takes capacity reservations and claims and hands them to the caller. | Perform any side effect. |
| `LeaseLifecycle` | `src/leasing/lease-lifecycle.ts` | Grant, renew, the registry half of a release, expiry scheduling through `LeaseExpiryScheduler`. | Reclaim; wake the queue. |
| `LeaseExpiryScheduler` | `src/leasing/lease-expiry-scheduler.ts` | TTL timers, delivered to the release coordinator. | Decide what expiry means. |
| `LeaseReleaseCoordinator` | `src/leasing/lease-release-coordinator.ts` | Release, release-all, expiry, device-lost and the startup ending (reclaim, wait with no reclaim started, or missing in one write) as lease commands: the serialized commit, the lease-end participants called after it (bounded by `lease.endWaitMs`, cut short by nuke, stop and dispose), the backgrounded reclaim with its claim, the drain for nuke and daemon stop, maintenance admission. | Purge or decide warmth: it hands the released device to `ReclaimCoordinator`. |
| `LeaseHealthMonitor` | `src/leasing/lease-health-monitor.ts` | Observing leased devices on a tick, rebooting a crashed one under its lease, giving the lease up as `device-lost` when recovery is exhausted. | Touch an unleased device. |
| `PhysicalDeviceWatcher` | `src/leasing/physical-device-watcher.ts` | The presence tick (every `health.probeIntervalMs`, whatever `health.enabled` says), the grace-period count of not-present reads, `absent` and its reason, the device-lost ending of a lease on a device that is gone, and the return reclaim of a device that is back (ADR 0022 §7). | Retry quarantine, grant, or run a driver verb but the presence listing on a leased device. |

## Agent-device edge

`src/agent-device/` holds the agent-device daemon a worker runs beside its drivers (ADR 0023). It is entered only through `src/agent-device/index.ts`; the core, leasing and the drivers import nothing from it, and its non-test files import no `fs` or `child_process`.

| Component | Where | Owns | Does not |
|---|---|---|---|
| `AgentDeviceSupervisor` | `src/agent-device/host/agent-device-supervisor.ts` | Starting, watching and stopping the one agent-device daemon: reaping one a killed simlock left (by a pid record and an identity check), the private state dir and policy file, the daemon's environment, readiness through `daemon.json`, the port and `/health`, restart on death, and the availability state (`off`, `starting`, `running`, `unavailable` with a reason and remedy). | Serve agent-device traffic; report to `simlock doctor`; decide which devices exist (the drivers' environments do). |
| Install lookup, compatibility, daemon environment | `src/agent-device/host/install.ts`, `src/agent-device/shared/` | Finding the agent-device install and its daemon entry; the minimum versions and RPC protocol; the environment and policy data. | Run a process. |
| `AgentDeviceHealthProbe` | `src/agent-device/host/health.ts` | The `GET /health` read, with a time limit. | Judge the answer. |
| Front | `src/agent-device/front/` | The `/v1/agent-device/*` mount: the role check, the route list, the `/rpc` body check, the request rules (platform, device selectors, device set, sharding, install, `devices`) and the `devices` filter, turning an agent-device `allocate` into a simlock `lease.request` (and its cancel when the CLI leaves) and a `release` into a `lease.release`, the front map of the leases it made, and who ended each; the heartbeat, which renews the simlock lease after agent-device answers, and the renewals while a command runs. | Check a token (the app does); run the proxy. |
| Relay host link | `src/agent-device/front/relay-host-link.ts` | On a gateway: the front's host link. It finds the worker that holds a lease (the gateway's lease index, and a memory of a lease the index dropped, kept for the gateway's `lease.maxTtlMs`), checks the lease is the token's, and relays the request there with the tenant `gw.<gateway instance id>.<principal>`; it reports whether any capable worker exists. | Import from `src/gateway` (it reads a port the daemon builds); decide which worker a new lease lands on (leasing does, from `requires`). |
| `AgentDeviceHost`, `AgentDeviceUpstream` | `src/agent-device/host/host.ts`, `host/upstream.ts` | `@agent-device/proxy` in front of the daemon, one proxy per daemon start; the tenant each request acts as; the port the daemon is reached through and its supervisor adapter. | Know simlock leases. |
| `ReleaseScopeRecord`, `AgentDeviceLeaseEnd` | `src/agent-device/host/lease-end.ts` | The host's record of each agent-device lease's release scope (filled by a recording wrapper around the proxy's upstream fetch), and the `LeaseEndParticipant` that, when simlock ends a lease, waits for a running allocate or release and releases the agent-device lease with that scope before the wipe. | Write to the front map; bound a wait with a timer (leasing's signal bounds it). |
| Wire rules | `src/agent-device/shared/` | The path prefixes, the route and RPC method lists, the selector reader, the `/rpc` body reader, the call classifier, the lease-call field reader, the release scope reader, the reply reader (an allocate reply is a success only when its release scope passes) and the front's replies. | Decide what a call means. |
| `FakeAgentDevice` | `src/agent-device/testing.ts` | The in-memory agent-device daemon the proxy sits in front of in tests. | Appear in production code. |

## Drivers

| Component | Where | Owns | Does not |
|---|---|---|---|
| `Driver` interface | `src/core/driver.ts` | The verbs the core speaks: `resolveSpec`, `provision`, `makeReady`, `reclaim`, `shutdown`, `destroy`, `estimate`, `inspectPhysical`, `listPresentPhysical`, `listManaged`, `listCatalog`, component install and removal, passthrough, lease environment. | Carry platform concepts: addresses and driver data are opaque to the core. |
| iOS driver | `src/drivers/ios/` | `IosSimctlDriver`: every `simctl` call scoped to the owned device set, erase as the reclaim, the slim pass inside `makeReady`, the label list, runtime install, prerequisites; its physical handler (`physical.ts`) runs `xcrun devicectl` for enrolled iPhones and iPads (inspect, presence, uninstall reclaim) and `devicectl-exec.ts` holds the allowed list for `device.exec`. | Decide the default mode or anything about leases. |
| Android driver | `src/drivers/android/` | `AndroidDriver`: AVDs in the owned AVD home, Simlock's own adb server (`AdbServerSupervisor`, `AdbRegistrar`), the clean-baseline snapshot as the reclaim, device profiles, system-image install, prerequisites; enrolled phones through the host's default adb server (`AndroidPhysicalHandler`, behind the `DefaultAdbServerGate` protocol check). | Same as iOS. |
| Installer process | `src/drivers/installer-process.ts` | Running a platform's installer command with streamed progress. | Decide whether to install. |
| `FakeDriver` | `src/core/fake-driver.ts`, exported from `src/core/testing.ts` | A scripted in-memory driver for the fast test lane and `SIMLOCK_DRIVERS_MODULE` setups. | Touch a real device. |

## Host load

`src/host-load/` is entered only through its `index.ts` and imports nothing but `src/ports/` (ADR 0029). Core, leasing, the drivers, the gateway and the contract never import it; the composition root wires it.

| Component | Where | Owns | Does not |
|---|---|---|---|
| `HostLoadSampler` | `src/host-load/sampler.ts` | The machine's CPU, memory and disk load: one read at start and every 15 s, one read at a time and each bounded at 10 s, busy % from two successive CPU counters, the age of the reading, and one warn when a part that was read fails. Served from memory through `current()`. | Read the machine: the `HostLoadProbe` port does. Shape the wire block: the contract's `fitHostLoad` does. |
| `HostLoadProbe` adapters | `src/ports/host-load.ts` | `DarwinHostLoadProbe` (`sysctl`, `os.cpus()`), `LinuxHostLoadProbe` (`/proc/stat`, `/proc/meminfo`, `/proc/self/cgroup` and the cgroup v2 files under `/sys/fs/cgroup`), `FakeHostLoadProbe`, and `productionHostLoadProbe`. Each part is read on its own and left out when it fails. | Compute a percentage. |

## Event bus

| Component | Where | Owns | Does not |
|---|---|---|---|
| `EventBus` | `src/bus/index.ts` | Typed post-commit business facts, their ids and sequence, subscribers isolated from emitters, the in-memory ring `simlock events` replays. | Carry a step of a transaction (architecture rule 5). |
| `EventHistory` | `src/bus/event-file.ts` | The event file: every fact on disk, rotation by size and retention, replay across a restart. | Stop an emitter when a write fails. |

## Gateway

A gateway runs `src/gateway/` in place of core and leasing. It imports no
driver; from `src/leasing/` only the request book, the in-memory store, the wait
queue, their errors and their types; and from `src/core/` only the shapes those are
typed against and catalog matching (ARCHITECTURE.md, "Boundaries").

| Component | Where | Owns | Does not |
|---|---|---|---|
| `GatewayService` | `src/gateway/service.ts` | Lifecycle: the uplink listener, one `WorkerLink` per worker, feeding the registry, the periodic tick that backstops refreshes and sweeps expired views. | Answer an operation or define a view. |
| `WorkerLink` | `src/gateway/worker-link.ts` | One worker's uplink from the gateway's side: the typed admin client over it, the reads on connect, refreshes on worker events, relaying worker events with the worker's id. | Decide what a view means. |
| `WorkerRegistry`, drain store | `src/gateway/worker-registry.ts`, `src/gateway/drain-store.ts` | What a worker view is and when it changes; the facts emitted as views change; the one persisted bit, the drained set. | Talk to a worker. |
| `FleetLeaseCoordinator`, `FleetQueue`, `FleetLeaseIndex` | `src/gateway/fleet-coordinator.ts`, `src/gateway/queue.ts`, `src/gateway/lease-index.ts` | Admission, the fleet-wide one-lease rule and the lease-ID clash check, the fleet FIFO in a virtual and a physical line, dispatch of each queued request to the worker routing picks with `noWait`, retry on a cannot-serve refusal, forwarding lease and exec calls, projecting worker leases as fleet leases, naming a caller-chosen lease bare and routing it from the index. | Provision, evict, or hold a device opinion: a worker grants or refuses. |
| Routing | `src/gateway/routing.ts`, `src/gateway/routing/` (surface: `index.ts`) | The pure routing policy: an ordered list of stages (`takes-requests`, `can-serve`, `healthy`, `idle-queue`, `warm-hit`, `free-slot`, `ram-budget`, `free-capacity`) over worker views, selected by `gateway.routing`; a physical request skips the stages whose `appliesToPhysical` is `false` (`idle-queue`, `free-slot`, `ram-budget`, `free-capacity`) and matches the enrolled physical devices in each worker's view (`physicalMatch`). | Read anything but views; order stages from config. |
| `GatewayDispatcher` | `src/gateway/dispatcher.ts` | The second implementation of the contract's handlers (ADR 0005 §32): answered from the fleet, forwarded to one worker, or fanned out to all. | Define a second contract or role check. |
| Aggregate, component relay | `src/gateway/aggregate.ts`, `src/gateway/component-relay.ts` | The fleet expressed in one machine's shapes, as pure functions over views; asking every worker to install a component and collecting one outcome each. | Decide anything a worker decides. |
| `GatewayRelay` | `src/gateway/relay.ts` | Handing one HTTP exchange to a relay target on a worker over its uplink (ADR 0026): `relay.request`, the request body and the response body on a byte channel opened on the uplink's link, the head from a `relay-head` push; the deadline over the channel wait and the exchange, cancel and `WORKER_UNREACHABLE` on a lost uplink. | Route to a worker or know which module a target is. |
| `GatewayOwnerRoutedFacts` | `src/gateway/owner-routed-facts.ts` | The gateway's owner-attributed lease facts, from relayed worker events. | Emit a fact of its own. |

## Ports

Every external API the core and the daemon touch sits behind an interface in
`src/ports/`, each with a Node adapter and an in-memory fake (architecture
rule 9): `Clock`, `Filesystem`, `ProcessRunner` (and the logging wrapper),
`ProcessSupervisor`, `SystemStats`, `HostInfo`, `IdGenerator`, `IpcTransport`,
`HostLoadProbe`, `Logger` and log sinks, `ParentWatch`, `TcpProbe`, `TokenSecrets`,
`DaemonLauncher`, the uplink transport and its WebSocket adapters, and the
path helpers.

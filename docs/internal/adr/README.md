# Architecture decision records

One file per decision that shapes the system and would be expensive to
reverse. An ADR explains *why* a choice was made, so a later reader (human or
agent) can tell a deliberate constraint from an accident.

Naming: `NNNN-kebab-case-title.md`, numbered in the order decisions are
accepted. Numbers are never reused, and an ADR is never edited to say
something different — a decision that changes gets a new ADR that supersedes
the old one, and the old one's Status is updated to point at it.

Show the decision, not only describe it. Where it helps the reader, add
Mermaid diagrams: a flowchart of the modules or processes involved and how
they depend on each other, before and after the decision; a sequence
diagram of a request or flow the decision changes, failure paths included;
a state diagram when it changes the states a lease, device or worker can
be in. Each diagram has at most about ten boxes, and the text still states
the decision on its own.

Status values:

- **Proposed** — under discussion, not binding.
- **Accepted** — binding. Code that contradicts it is a bug.
- **Accepted — not yet implemented** — binding as a target; the code has not
  caught up. The ADR and the spec of the issue that links it are the
  specification. The PR that implements a change updates the docs it makes
  true. ADRs 0004 and 0005 were accepted with their docs already rewritten to
  the end state; for those two the docs are the specification too, and
  nobody "fixes" them back to match current behaviour.
- **Superseded by NNNN** — no longer binding; read the replacement.

An ADR's status follows the feature that produced it, per
[agent-rules/delivery.md](../agent-rules/delivery.md): it is *Proposed*
while the feature is still `feature:spec`, becomes *Accepted — not yet
implemented* when the feature leaves that state, and becomes *Accepted*
when the feature closes. An ADR that is *Accepted — not yet implemented*
with no open feature behind it is a gap: either the feature is missing or
the status is stale.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-simlock-owned-device-roots.md) | Simlock-owned device roots | Accepted; ownership proof and the adb server narrowed by 0022 for physical devices; per-home isolation as a user feature superseded by 0034; §1's layout narrowed by 0036 (`state.db`); §1, §2, §3, §5, §6 and §7 narrowed by 0048 for iOS under `deviceSet: "default"` |
| [0002](0002-opt-in-slim-ios-simulators.md) | Opt-in slim iOS simulators | Accepted |
| [0003](0003-one-typed-daemon-contract-behind-every-frontend.md) | One typed daemon contract behind every frontend | Accepted |
| [0004](0004-ttl-first-leases-on-every-transport.md) | TTL-first leases on every transport | Accepted — partly implemented: §2 (the CLI exits when its socket drops instead of keeping its lease) |
| [0005](0005-gateway-and-worker-modes.md) | Gateway and worker modes | Accepted — partly implemented: §16, §19a', §19c and §27a; requirement 1, the `mode` key and the two-homes setup superseded by 0034; requirement 3's joined-worker HTTP permission superseded by 0039 |
| [0006](0006-events-and-log-are-two-records.md) | Events and the daemon log are two records | Accepted; §2 narrowed by 0032 (the event record is a database) |
| [0007](0007-a-lease-request-chooses-the-device-mode.md) | A lease request chooses the device mode | Accepted |
| [0008](0008-the-catalog-pairs-models-with-runtimes-and-status-carries-host-facts.md) | The catalog pairs models with runtimes, and status carries host facts | Accepted; §3 narrowed by 0025 on Android |
| [0009](0009-gateway-routing-is-a-list-of-stages.md) | Gateway routing is a list of stages, and a request that cannot be served fails at once | Accepted — partly implemented: §6's `defaultRuntime` rule |
| [0010](0010-components-have-one-owner-in-the-core.md) | Components are installed, recorded and removed through one owner in the core | Accepted |
| [0011](0011-the-console-is-a-built-app-the-daemon-serves.md) | The console is a built app the daemon serves at `/` | Accepted |
| [0012](0012-a-worker-answers-the-fleet-operations-as-a-fleet-of-one.md) | A worker answers the fleet operations as a fleet of one | Accepted |
| [0013](0013-the-console-reads-routes-and-follows-the-event-stream.md) | The console reads the routes and follows the event stream | Accepted; §3 superseded by 0044 |
| [0014](0014-an-event-has-one-id-minted-where-the-fact-happened.md) | An event has one id, minted where the fact happened | Accepted; §6 narrowed by 0021 |
| [0015](0015-a-lease-request-is-a-set-of-constraints.md) | A lease request is a set of constraints, and the catalog says which class each model is | Accepted; §3 narrowed by 0022 for physical devices; §3–5 narrowed by 0025 on Android |
| [0016](0016-usage-figures-are-derived-on-read-from-the-event-history.md) | Usage figures are derived on read from the event history | Accepted — partly implemented: the event and retention parts are built, the reader (§1, §5–§8) is not; §6's fleet join and a Consequence superseded by 0021; §1 and §4 superseded by 0032 |
| [0017](0017-the-warm-pool-is-a-module-beside-the-lease-transaction.md) | The warm pool is a module beside the lease transaction, not a step in it | Accepted — partly implemented: §3 (the release path still calls into the pool); §2, §4, §5 and §8 narrowed by 0038 |
| [0018](0018-leasing-is-one-module-and-every-module-is-entered-through-its-index.md) | Leasing is one module, and every module is entered through its index | Accepted — partly implemented: §3 and §4's warm-pool name rule; §4's path rules superseded by 0027; §1's one-write wording narrowed by 0036 |
| [0019](0019-startup-ends-every-lease-whose-device-is-not-running.md) | Startup ends every lease whose device is not running | Accepted; §1–2 narrowed by 0022 for physical devices; §4 narrowed by 0036 (a replay reads the current device) |
| [0020](0020-a-requester-may-choose-its-lease-id.md) | A requester may choose its lease id, and the gateway passes it through bare | Accepted |
| [0021](0021-a-gateway-dispatch-is-a-probe-and-names-its-fleet-request.md) | A gateway dispatch is a probe, and the gateway records every fleet request's outcome | Accepted — partly implemented: §5 (usage figures) is not built |
| [0022](0022-a-physical-device-is-a-second-device-type-the-core-knows.md) | A physical device is a second device type the core knows | Proposed; amends 0001 §3 and §5, 0015 §3 and 0019 §1–2 for physical devices |
| [0023](0023-agent-device-is-served-by-an-optional-edge-module.md) | agent-device is served by an optional edge module, and the simlock lease is the only clock | Accepted; §1 narrowed by 0026 for gateway mode; §3 narrowed by 0030 (no reap while turned off); §3–4 superseded in part by 0043; §1, §3–4 narrowed by 0046 |
| [0024](0024-leasing-calls-lease-end-participants-before-reclaim.md) | Leasing calls lease-end participants before it reclaims a device | Accepted |
| [0025](0025-simlock-ships-android-profiles-and-a-model-pairs-only-with-images-that-fit.md) | Simlock ships Android device profiles, and a model pairs only with images that fit it | Accepted |
| [0026](0026-agent-device-through-a-gateway-relays-over-the-uplink.md) | agent-device through a gateway: workers advertise capabilities, and the host link relays over the uplink | Accepted; §2 narrowed by 0028 for relayed bodies; §3's in-process link narrowed by 0043 |
| [0027](0027-dependency-cruiser-checks-every-component-boundary.md) | dependency-cruiser checks every component's boundary and the module graph | Accepted |
| [0028](0028-the-uplink-carries-byte-channels-and-small-messages-go-first.md) | The uplink carries byte channels beside its messages, and small messages go first | Accepted |
| [0029](0029-host-load-is-an-optional-module-whose-readings-ride-on-status.md) | Host load is an optional module whose readings ride on status | Accepted |
| [0030](0030-optional-modules-share-one-contract-and-load-only-when-turned-on.md) | Optional modules share one contract and load only when turned on | Accepted — not yet implemented; §2 narrowed by 0046 |
| [0031](0031-a-physical-iphone-streams-through-coredevice-behind-a-screen-source-seam.md) | A physical iPhone streams through CoreDevice's media stream, behind a screen-source seam | Accepted |
| [0032](0032-the-event-history-is-a-sqlite-database-with-projections-beside-it.md) | The event history is a SQLite database, with projections beside it | Accepted — not yet implemented; §1 narrowed by 0036 |
| [0033](0033-a-sign-in-proxy-is-a-second-way-to-sign-in-and-auth-is-one-module.md) | A sign-in proxy is a second way to sign in, and auth is one module | Accepted — not yet implemented |
| [0034](0034-one-worker-per-user-and-the-folder-says-what-a-daemon-is.md) | One worker per user, and the folder says what a daemon is | Accepted — not yet implemented |
| [0035](0035-a-gateway-sends-chosen-fleet-events-to-webhook-destinations.md) | A gateway sends chosen fleet events to webhook destinations | Accepted — not yet implemented |
| [0036](0036-daemon-state-is-a-sqlite-database-whose-tables-each-owner-keeps.md) | Daemon state is a SQLite database, and each owner keeps its own tables | Accepted — not yet implemented |
| [0037](0037-the-console-acts-through-the-http-routes-on-base-ui.md) | The console acts through the HTTP routes, on Base UI | Accepted — not yet implemented |
| [0038](0038-the-warm-pool-learns-its-kinds-from-leases-and-boots-for-every-queued-request.md) | The warm pool learns its kinds from leases, and boots for every queued request | Accepted — not yet implemented |
| [0039](0039-joined-workers-refuse-their-own-http-listener.md) | Joined workers refuse their own HTTP listener | Accepted — not yet implemented; narrowed by 0046 |
| [0040](0040-every-http-route-is-declared-once-and-the-openapi-document-is-built-from-the-declarations.md) | Every HTTP route is declared once, and the OpenAPI document is built from the declarations | Accepted — not yet implemented; its stream-route example stale since 0045 |
| [0041](0041-the-daemon-can-run-under-the-users-service-manager.md) | The daemon can run under the user's service manager | Accepted — not yet implemented |
| [0042](0042-simlock-updates-itself-through-a-frozen-call-and-a-detached-updater.md) | Simlock updates itself through a frozen call and a detached updater | Accepted — not yet implemented; narrows 0009's `takes-requests` stage |
| [0043](0043-physical-devices-reach-agent-device-through-a-second-daemon.md) | Physical devices reach agent-device through a second daemon on the worker | Accepted — not yet implemented; supersedes 0023 §3–4 in part; §4 narrowed by 0046 |
| [0044](0044-the-console-reads-what-its-page-shows-and-events-mark-it-stale.md) | The console reads what its page shows, and events mark it stale | Accepted — not yet implemented; supersedes 0013 §3 |
| [0045](0045-a-devices-screen-streams-to-operators-not-a-leases.md) | A device's screen streams to operators, not a lease's | Accepted — not yet implemented |
| [0046](0046-a-standalone-worker-serves-agent-device-by-default-with-a-private-profile.md) | A standalone worker serves agent-device by default and hands local agents a private profile | Accepted — not yet implemented; narrows 0023 §1, §3–4, 0030 §2, 0039 and 0043 §4 |
| [0047](0047-device-exec-fills-in-the-leases-device.md) | `device.exec` fills in the lease's device, and refuses another | Accepted — not yet implemented; extends 0005 §19a; narrows 0003 §11 for one MCP tool |
| [0048](0048-an-ios-worker-may-keep-its-simulators-in-xcodes-device-set.md) | An iOS worker may keep its simulators in Xcode's device set | Accepted — not yet implemented; narrows 0001 §1, §2, §3, §5, §6 and §7 for iOS under `deviceSet: "default"` |

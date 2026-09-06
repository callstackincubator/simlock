# Post-v1 ideas

Things discussed and deliberately deferred. Roughly ordered by expected value.

## Warm pool

The benchmark showed ~30s of boot is a fixed floor on iOS (and Android without
a snapshot). Keeping clean, unleased devices running after release would
collapse a repeated lease acquisition to sub-second on both platforms. The
pool is an adaptive cache across every requested spec rather than a set of
per-spec quotas. Leased devices and active requests take priority, and the
global and platform `maxRunning` limits bound leased, reclaiming, and ready
devices together. A cache miss evicts the least-recently-used eligible device
that frees the constrained capacity.

The first warm-pool version is release-driven: it does not proactively boot
shutdown devices on daemon startup or merely to fill unused running capacity.
A device enters the warm pool only after an actual lease releases it. Simlock
also does not provision devices solely to fill the warm pool. Warm devices
still shut down after the existing T1 idle timeout; the pool is not refilled
afterward until real lease activity releases another device.

## Orphaned-holder fix (shipped)

Parent-death watch in the holder process, behind a `ParentWatch` port, so a
crashed agent's backgrounded lease holder self-terminates, plus the
`--bind-pid` escape hatch for subshell-spawned holders. The plan called for
`kqueue`/`EVFILT_PROC` on macOS and `prctl(PR_SET_PDEATHSIG)` on Linux;
neither is reachable from plain Node without a native addon, so the shipped
adapter polls instead. Details in [known-pitfalls.md](known-pitfalls.md).

## MCP server

Agents are the audience; a `lease_simulator` MCP tool with structured output
is friendlier than parsing CLI output. Thin wrapper over the same daemon
protocol — the core must not care which frontend called it.

## Multi-device atomic leases

Device-to-device tests need two devices at once; sequential acquisition by
multiple agents can deadlock. Requires atomic all-or-nothing acquisition in
the queue. v1 rule is one lease per agent.

## Physical-device driver

A third driver (devicectl / adb-over-USB) where `provision` is a no-op and
`reclaim` is uninstall-and-reset. Also the litmus test that the core/driver
boundary held.

## Clone-from-golden baseline option (iOS)

`simctl clone` is as cheap as erase but preserves a *provisioned* baseline
(pre-installed certs, test apps). Offer per-pool config: reclaim by erase
(default) or by re-clone from a maintained golden device.

## Parse Apple's downloadables index for exact runtime versions (iOS)

The bounded-default download path (`IosSimctlDriver#resolveDefaultRuntime`,
`src/drivers/ios/index.ts`) can only ask `xcodebuild -downloadPlatform iOS
-buildVersion <major>` when no `--os` was given and the model's pairing range
has an upper bound — the bare major version, not an exact patch release,
because the exact downloadable versions for the installed Xcode aren't known
offline. Xcode's own downloadable-runtimes catalog (fetched by Xcode/App
Store internally) would let the driver resolve the exact newest compatible
patch release instead of gambling on the major matching a real build. Not
pursued in v1: parsing an undocumented, Apple-controlled catalog format is a
maintenance burden disproportionate to the edge case it closes (see
`docs/known-pitfalls.md`, "Component downloads").

## Requester-visible download progress

Neither driver's install (`xcodebuild -downloadPlatform`, `sdkmanager
--install`) currently reaches the requesting connection's progress stream —
see `docs/known-pitfalls.md` ("no progress push"). Closing this needs a
`downloading` stage on `LeaseProgress` (`src/core/wait-queue.ts`) and a
`Driver.resolveSpec` progress callback both drivers implement, threaded
through `LeaseAcquisitionCoordinator#resolveAndDrive` the same way
`provision`/`makeReady` already report `provisioning`/`booting`. Deferred
because it is protocol machinery (interface + CLI/MCP wire changes), not a
small addition, and the daemon-side `component.install-started` bus event
already gives an operator visibility via `simlock events --follow` even
though the waiting requester itself does not see it yet.

## Gateway-side file upload for `device.exec`

`device.exec` runs a `simctl`/`adb` command on the machine that owns the
device, so a path in its arguments (`simctl install <path>`, `adb install
<apk>`) resolves on *that* filesystem. Getting an artifact there is out of
band in v1 — a shared volume, a CI checkout on the worker. The designed shape
for closing this is `device.upload`: chunks streamed as request-scoped pushes
over the same wire `device.exec` already uses, into a per-lease scratch
directory deleted on release. [ADR
0005](adr/0005-gateway-and-worker-modes.md) leaves that seam open on purpose
and does not build it; a remote agent that has to install a build it just
produced is the case that will decide when it is worth it.

## Capacity slices reserved for the gateway

A worker's capacity is shared between its local agents and the fleet, with
the worker's own accounting as the single arbiter (ADR 0005 §12). A worker
could instead reserve a slice for gateway traffic, so a busy local developer
cannot starve the fleet. Deferred: it adds a worker-side concept for a
problem the worker views already make *visible*, and an operator who sees one
machine's local load can drain it instead.

## A fleet-wide doctor, as a new operation

`nuke.run`, `cleanup.run`, and `doctor.run` stay per-worker, and a gateway's
`UNSUPPORTED_IN_GATEWAY_MODE` for them is permanent rather than a placeholder
([ADR 0005](adr/0005-gateway-and-worker-modes.md), "Alternatives
considered"). What is deferred is not those three answering differently one
day — it is a **new operation** that fans the read-only half out to every
worker and merges the findings, which is exactly what a multi-worker console
wants to render. Giving it its own name is the point: `doctor.run` means "one
machine", a fleet-wide reconnaissance pass means something else, and a caller
should be able to tell which one it invoked from the name rather than from
which daemon happened to answer. The destructive half (`--fix`, `cleanup`,
`nuke`) is deferred harder still: a fleet-wide destructive command from one
endpoint is not something this tool should offer casually, whatever it is
called.

## Richer routing: label selectors and requester affinity

The v1 routing policy is warm hit, then most free capacity, and nothing else
— no requester affinity, no label selectors, no per-worker platform
exclusions (`label` is display-only). Each is a future policy behind
`gateway.routing`, which is a pure function over worker views with one entry
point, so adding one is a new module rather than a change to the request
shape. Affinity ("give this agent the machine its build cache is on") is the
one with the clearest payoff; selectors ("only the M4 Macs") the one most
likely to be asked for first.

## A byte-heavy data plane

Device *commands* travel through the gateway (`device.exec`); live screen
streaming, port forwarding, and interactive TTYs do not, and `dataPlane` on
the lease object stays reserved for them. They need sustained throughput and
a session, not a request/response with output pushes, which is a different
transport decision from the one ADR 0005 makes.

## Priorities / preemption

Priority classes in the wait queue; possibly preempting long-idle leases.
Deferred until fairness of plain FIFO proves insufficient.

## Usage metrics

Utilization, wait-time percentiles, provision durations — derivable from the
event ring buffer once it exists.

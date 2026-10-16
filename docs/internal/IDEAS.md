# Post-v1 ideas

Things discussed and deliberately deferred. Roughly ordered by expected value.

## Warm pool targets, further

Deferred from the warm pool: targets named by class, changing targets
without a restart, and fleet-level targets on a gateway.

## MCP server

Agents are the audience; a `lease_simulator` MCP tool with structured output
is friendlier than parsing CLI output. Thin wrapper over the same daemon
protocol — the core must not care which frontend called it.

## Multi-device atomic leases

Device-to-device tests need two devices at once; sequential acquisition by
multiple agents can deadlock. Requires atomic all-or-nothing acquisition in
the queue. v1 rule is one lease per agent.

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
the known gaps in [the core manual](../../src/core/AGENTS.md)).

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

The v1 routing policy is health, queue, warm hit, free slot, RAM budget, then most
free capacity, and nothing else — no requester affinity, no label selectors, no per-worker platform
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

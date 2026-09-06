### A control plane so parallel coding agents stop fighting over the same simulator

Simlock is a CLI-first control plane for iOS simulators and Android
emulators, built for environments where multiple coding agents run at the
same time — on one machine, or across a fleet of them behind a single
address. Agents don't touch `simctl` or `avdmanager`
directly — they ask Simlock for a device and get one back, booted and
health-checked, that no other agent will touch until they're done with it.

## Why you'd want this

**Two agents, one simulator, zero coordination.** Left to themselves, agents
that need a device grab whatever `simctl` / `avdmanager` happens to show
them. Two agents that pick the same one start booting, erasing, and
installing over each other — without either ever knowing the other exists.
Simlock gives them a single primitive instead: **lease a device**.

**You don't provision devices by hand.** If nothing matching is free,
Simlock provisions one itself, up to a capacity limit it derives from the
machine's CPU and RAM. Once that limit is reached, further requests block
and wait in a fair queue rather than failing outright, with `--timeout` and
`--no-wait` escape hatches for callers that want different behavior.

**Idle devices don't sit there burning RAM and disk.** A device nobody's
using is shut down after a short idle period to reclaim RAM, then deleted
after a longer one to reclaim disk — automatically, in tiers.

**A crashed simulator doesn't just quietly cost you a device.** If a leased
device's process dies outside simlock, Simlock notices, reboots it under the
same lease, and tells the holder — it can't restore whatever was running
inside the device when it died, but the lease and its device don't just
vanish.

**One machine is a starting point, not a limit.** A simlock daemon runs
either as a **worker** — what every daemon is today, owning the devices on
its own machine — or as a **gateway**, which owns no devices and fronts the
workers that have joined it ([ADR
0005](docs/adr/0005-gateway-and-worker-modes.md)). Workers dial _out_ to the
gateway over a single WebSocket uplink, so a Mac behind NAT joins a fleet
with a URL and a join token and never needs an inbound port; the gateway
keeps one fleet-wide queue and sends each request to the worker best placed
to serve it — a warm device if one is free, otherwise the machine with the
most free capacity. Agents and the console point at **one URL** and stop
caring which machine a device lives on, because a gateway speaks the same
contract a worker does: the same `lease`, `renew`, `release`, and `status`,
with `simlock simctl` / `simlock adb` proxied through to the worker that owns
the device. The gateway never touches a device itself — capacity, the
registry, and every safety rule stay on the worker, which also keeps serving
its own local agents as before.

**It's advisory, not a sandbox.** Simlock doesn't wrap or intercept
`simctl` / `avdmanager` — it works because agents are instructed to only use
devices handed to them by a lease. What it _does_ enforce is its own blast
radius: Simlock only ever shuts down, erases, or deletes devices it created
itself. Everything else on the machine is read-only to it.

**Built for agents first, humans second.** Lease results are one JSON line
on stdout; progress (queueing, provisioning ETAs, boot) streams as JSON
lines on stderr. Status and other operator-facing commands default to a
human-readable view and take `--json` when a script wants the structured
form instead.

## What it looks like

```sh
simlock lease --platform ios --device "iPhone 16" --detach
```

```json
{
  "device": {
    "id": "dev_1a2b",
    "driverDeviceId": "ABCD-...",
    "spec": { "platform": "ios", "model": "iPhone 16", "osVersion": "18.4" },
    "address": "ABCD-..."
  },
  "lease": {
    "id": "lse_9f2c",
    "deviceId": "dev_1a2b",
    "requesterId": "agent-1",
    "ownerId": "agent-1",
    "grantedAt": 1735689600000,
    "ttlMs": 900000,
    "lastRenewedAt": 1735689600000,
    "ttlDeadline": 1735690500000
  },
  "timing": {
    "estimatedProvisionMs": 0,
    "estimatedBootMs": 0,
    "estimatedReclaimMs": 0,
    "estimatedReadyMs": 0
  },
  "role": "admin"
}
```

That's the whole interaction: ask for a platform and a device model, get
back an identified, ready-to-use device. Release it explicitly, renew it
before `ttlDeadline` to keep it, or let its TTL expire. Drop `--detach` and
`simlock lease` stays running instead, doing the first two for you — renewing
on a timer and releasing when it exits. This is the contract's own
`LeaseGrant` shape, serialized as-is — the CLI's `--json` output is a
contract value, not a bespoke rendering (see [docs/CLI.md](docs/CLI.md)).

Now say a second agent asks for the same `iPhone 16` a moment later. It's
already leased to the first agent — no problem, Simlock just provisions
another one. Progress streams as JSON lines on stderr while it happens, and
the lease result lands on stdout the moment the new device is ready:

```json
{"push":"progress","stage":"provisioning","etaMs":5000}
{"push":"progress","stage":"booting","etaMs":30000}
```

```json
{
  "device": {
    "id": "dev_3c4d",
    "driverDeviceId": "EFGH-...",
    "spec": { "platform": "ios", "model": "iPhone 16", "osVersion": "18.4" },
    "address": "EFGH-..."
  },
  "lease": {
    "id": "lse_a731",
    "deviceId": "dev_3c4d",
    "requesterId": "agent-2",
    "ownerId": "agent-2",
    "grantedAt": 1735689630000,
    "ttlMs": 900000,
    "lastRenewedAt": 1735689630000,
    "ttlDeadline": 1735690530000
  },
  "timing": {
    "estimatedProvisionMs": 5000,
    "estimatedBootMs": 30000,
    "estimatedReclaimMs": 0,
    "estimatedReadyMs": 35000
  },
  "role": "admin"
}
```

No manual bookkeeping, no "device busy" error to handle — just a second
device, a few seconds later. That keeps up until the machine's capacity
limit is reached (derived from its CPU and RAM, or set explicitly in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md)); after that, further
requests wait in a fair queue instead of failing, with `--timeout` and
`--no-wait` for callers that want different behavior.

Agents that speak the Model Context Protocol can skip the CLI entirely and
get the same lease/release workflow as tools, through a local stdio server:

```json
{
  "mcpServers": {
    "simlock": {
      "command": "simlock",
      "args": ["mcp"],
      "env": { "SIMLOCK_AGENT_ID": "agent-1" }
    }
  }
}
```

## Getting started

```sh
pnpm install
pnpm build
simlock lease --platform ios --device "iPhone 16" --detach
simlock status --json
```

The daemon starts on demand — there's no separate setup step. Use
`simlock doctor` to reconcile managed state with reality, and
`simlock nuke --yes --delete-devices` only for an emergency reset of
Simlock-managed devices.

See [docs/CLI.md](docs/CLI.md) for the full command reference and
[docs/CLI.md#simlock-mcp](docs/CLI.md#simlock-mcp) or the [README section
below](#mcp-integration-optional) for wiring up an MCP client.

## MCP integration (optional)

The CLI remains Simlock's primary, full operator interface. MCP is a narrower,
agent-focused integration: it intentionally exposes neither status,
configuration, events, manual lease renewal, nor destructive or other operator
commands — the server renews its own session's lease on a timer, so an agent
never has to ask it to. Start it with `simlock mcp` — it reserves stdout for
MCP JSON-RPC, so lease results never mix with protocol framing.

`SIMLOCK_AGENT_ID` sets the server's stable requester identity. Simlock
allows at most one active lease per identity, so give each agent session a
distinct, stable id — run one MCP server process per agent session, each
with its own id.

The server exposes exactly four tools: `list_devices` (read-only catalog of
what can be leased), `lease_simulator`, `release_simulator`, and `lease_status`
(cheap, safe to poll after a context compaction to check whether a device is
still leased to this session). Full tool contracts, progress reporting, and
lease-loss notifications are documented in
[docs/CLI.md](docs/CLI.md#simlock-mcp).

## Documentation

- [docs/ABOUT.md](docs/ABOUT.md) — what the tool is and the problem it solves, in short form
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the daemon, drivers, and frontends fit together
- [docs/CLI.md](docs/CLI.md) — the full command reference
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — every config key, its default, and how limits interact
- [docs/EVENTS.md](docs/EVENTS.md) — catalog of business events on `simlock events`
- [docs/known-pitfalls.md](docs/known-pitfalls.md) — accepted gaps and their planned fixes
- [docs/IDEAS.md](docs/IDEAS.md) — post-v1 ideas, not yet built

## Made with ❤️ at Callstack

`simlock` is an open source project and will always remain free to use. If
you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love]
is a group of React and React Native geeks, contact us at
[hello@callstack.com](mailto:hello@callstack.com) if you need any help with
these or just want to say hi!

Like the project? ⛸️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=simlock&utm_term=readme-with-love

### A control plane so parallel coding agents stop fighting over the same simulator

Pitlane is a CLI-first control plane for iOS simulators and Android
emulators, built for environments where multiple coding agents run on one
machine at the same time. Agents don't touch `simctl` or `avdmanager`
directly — they ask Pitlane for a device and get one back, booted and
health-checked, that no other agent will touch until they're done with it.

## Why you'd want this

**Two agents, one simulator, zero coordination.** Left to themselves, agents
that need a device grab whatever `simctl` / `avdmanager` happens to show
them. Two agents that pick the same one start booting, erasing, and
installing over each other — without either ever knowing the other exists.
Pitlane gives them a single primitive instead: **lease a device**.

**You don't provision devices by hand.** If nothing matching is free,
Pitlane provisions one itself, up to a capacity limit it derives from the
machine's CPU and RAM. Once that limit is reached, further requests block
and wait in a fair queue rather than failing outright, with `--timeout` and
`--no-wait` escape hatches for callers that want different behavior.

**Idle devices don't sit there burning RAM and disk.** A device nobody's
using is shut down after a short idle period to reclaim RAM, then deleted
after a longer one to reclaim disk — automatically, in tiers.

**It's advisory, not a sandbox.** Pitlane doesn't wrap or intercept
`simctl` / `avdmanager` — it works because agents are instructed to only use
devices handed to them by a lease. What it *does* enforce is its own blast
radius: Pitlane only ever shuts down, erases, or deletes devices it created
itself. Everything else on the machine is read-only to it.

**Built for agents first, humans second.** Lease results are one JSON line
on stdout; progress (queueing, provisioning ETAs, boot) streams as JSON
lines on stderr. Status and other operator-facing commands default to a
human-readable view and take `--json` when a script wants the structured
form instead.

## What it looks like

```sh
pitlane lease --platform ios --device "iPhone 16" --detach
```

```json
{"lease":"lse_9f2c","platform":"ios","device":"iPhone 16","os":"18.4","udid":"ABCD-...","state":"leased"}
```

That's the whole interaction: ask for a platform and a device model, get
back an identified, ready-to-use device. Release it explicitly, or let its
TTL expire.

Now say a second agent asks for the same `iPhone 16` a moment later. It's
already leased to the first agent — no problem, Pitlane just provisions
another one. Progress streams as JSON lines on stderr while it happens, and
the lease result lands on stdout the moment the new device is ready:

```json
{"event":"provisioning","eta_seconds":5}
{"event":"booting","eta_seconds":30}
```

```json
{"lease":"lse_a731","platform":"ios","device":"iPhone 16","os":"18.4","udid":"EFGH-...","state":"leased"}
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
    "pitlane": {
      "command": "pitlane",
      "args": ["mcp"],
      "env": { "PITLANE_AGENT_ID": "agent-1" }
    }
  }
}
```

## Getting started

```sh
pnpm install
pnpm build
pitlane lease --platform ios --device "iPhone 16" --detach
pitlane status --json
```

The daemon starts on demand — there's no separate setup step. Use
`pitlane doctor` to reconcile managed state with reality, and
`pitlane nuke --yes --delete-devices` only for an emergency reset of
Pitlane-managed devices.

See [docs/CLI.md](docs/CLI.md) for the full command reference and
[docs/CLI.md#mcp-integration-optional](docs/CLI.md) or the [README section
below](#mcp-integration-optional) for wiring up an MCP client.

## MCP integration (optional)

The CLI remains Pitlane's primary, full operator interface. MCP is a
narrower, agent-focused integration: it intentionally exposes neither
status, configuration, events, lease renewal, nor destructive or other
operator commands. Start it with `pitlane mcp` — it reserves stdout for MCP
JSON-RPC, so lease results never mix with protocol framing.

`PITLANE_AGENT_ID` sets the server's stable requester identity. Pitlane
allows at most one active lease per identity, so give each agent session a
distinct, stable id — run one MCP server process per agent session, each
with its own id.

The server exposes exactly four tools: `list_devices` (read-only catalog of
what can be leased), `lease_simulator`, `release_simulator`, and
`lease_status` (cheap, safe to poll after a context compaction to check
whether a device is still held). Full tool contracts, progress reporting,
and lease-loss notifications are documented in
[docs/CLI.md](docs/CLI.md#pitlane-mcp).

## Documentation

- [docs/ABOUT.md](docs/ABOUT.md) — what the tool is and the problem it solves, in short form
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the daemon, drivers, and frontends fit together
- [docs/CLI.md](docs/CLI.md) — the full command reference
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — every config key, its default, and how limits interact
- [docs/EVENTS.md](docs/EVENTS.md) — catalog of business events on `pitlane events`
- [docs/known-pitfalls.md](docs/known-pitfalls.md) — accepted gaps and their planned fixes
- [docs/IDEAS.md](docs/IDEAS.md) — post-v1 ideas, not yet built

## Made with ❤️ at Callstack

`pitlane` is an open source project and will always remain free to use. If
you think it's cool, please star it 🌟. [Callstack][callstack-readme-with-love]
is a group of React and React Native geeks, contact us at
[hello@callstack.com](mailto:hello@callstack.com) if you need any help with
these or just want to say hi!

Like the project? ⛸️ [Join the team](https://callstack.com/careers/?utm_campaign=Senior_RN&utm_source=github&utm_medium=readme) who does amazing stuff for clients and drives React Native Open Source! 🔥

[callstack-readme-with-love]: https://callstack.com/?utm_source=github.com&utm_medium=referral&utm_campaign=pitlane&utm_term=readme-with-love

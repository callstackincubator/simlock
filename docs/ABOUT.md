# Simlock

Simlock is a control plane for iOS simulators and Android emulators, built for
environments where multiple coding agents run in parallel on one machine.

## The problem

Agents that need a simulator grab whatever `simctl` / `avdmanager` shows them.
Two agents that pick the same device start fighting over it — booting, erasing,
and installing over each other — without ever knowing the other exists.

## The solution

Simlock is a CLI-first control plane (backed by a local daemon) that is the
same for both platforms and gives agents one primitive: **lease a device**.
An optional local stdio MCP integration exposes the focused lease/release
workflow to compatible agent clients; the CLI remains the full operator
interface. An optional, token-authenticated HTTP API lets remote agents lease
devices from a self-hosted simlock host over the network (see
[HTTP-API.md](HTTP-API.md)).

- `simlock lease` returns a *ready* device — booted and health-checked — that
  no other agent will touch for the duration of the lease.
- If no matching device is free, simlock **provisions** one, up to a
  configurable capacity limit derived from the machine's CPU and RAM.
- If the limit is reached, the CLI **blocks and waits** in a fair queue until a
  device frees up (with `--timeout` and `--no-wait` escape hatches).
- Devices that sit unused are **cleaned up in tiers**: shut down after a short
  idle period (reclaim RAM), deleted after a longer one (reclaim disk).

## Key properties

- **Advisory coordination.** Simlock does not sandbox anything. It works
  because agents are instructed to never call `simctl` / `avdmanager` directly
  and to only use devices handed to them by a lease.
- **Process-held leases.** The `lease` command stays running in the
  background; the open connection to the daemon is the heartbeat. Killing the
  process releases the lease. A daemon-side TTL is the backstop for zombies.
- **One lease per agent** (v1).
- **Managed-device registry.** Simlock only ever shuts down, erases, or
  deletes devices it created itself. Everything else on the machine is
  read-only to it.
- **Agent-first output.** CLI lease results are one JSON line on stdout;
  progress (e.g. provisioning ETAs) streams as JSON lines on stderr. The
  optional MCP server reserves stdout for MCP JSON-RPC.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it's built, [CLI.md](CLI.md)
for the command surface, and [known-pitfalls.md](known-pitfalls.md) for
accepted gaps.

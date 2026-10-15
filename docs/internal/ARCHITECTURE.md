# Architecture

The map. Each module's manual (`src/<module>/AGENTS.md`) says how it works;
each flow doc under [flows/](flows/) follows one path across modules; the
[ADRs](adr/) say why.

## Topology

A **worker** is one daemon owning the simulators and emulators (and enrolled
phones) on one machine. A **gateway** owns no device; workers dial out to it
and it fronts them as one fleet. `mode` in the config picks which a daemon is.

```
agent ─spawns─> simlock CLI ──┐
MCP client ─> stdio MCP ──────┼─ simlock/client ── unix socket ──┐
                              │                                  ▼
remote agent ── bearer token ─> HTTP frontend ── in process ──> Dispatcher ── handlers
console (browser) ────────────┘                                  │
                                                  worker: leasing + core ── drivers ── simctl / adb / devicectl
                                                  gateway: fleet coordinator ── worker views
                                                                  ▲
worker daemon ── uplink (WebSocket to /v1/uplink, worker dials) ──┘
```

- One contract, one `Dispatcher` per daemon, every transport. HTTP calls the
  dispatcher in process, never through the socket.
- A gateway is a second set of handlers for the same contract. Every frontend
  works against either mode unchanged.
- State lives on the worker (`state.json`, written only by core's
  `Registry`). A gateway keeps only its tokens, its instance id and its drained-worker set on
  disk; everything else is rebuilt from the workers that reconnect.

## Modules

| Module | Does | Manual |
|---|---|---|
| contract | Every operation, schema, role, error code, protocol range | [contract](../../src/contract/AGENTS.md) |
| modules | Optional-module contract and the host that loads each turned-on module | [modules](../../src/modules/AGENTS.md) |
| module-registry | The list of optional modules, read by the composition root and the CLI | [module-registry](../../src/module-registry/AGENTS.md) |
| daemon | Composition root, socket server, `Dispatcher`, sessions, uplink dialler | [daemon](../../src/daemon/AGENTS.md) |
| leasing | Every lease rule: admit, queue, plan, grant, renew, end | [leasing](../../src/leasing/AGENTS.md) |
| core | Registry, device lifecycle, reclaim, quarantine, cleanup, components, doctor | [core](../../src/core/AGENTS.md) |
| core/warm-pool | What stays booted, and warm targets | [warm-pool](../../src/core/warm-pool/AGENTS.md) |
| core/capacity | Limits, RAM budget, reservations | [capacity](../../src/core/capacity/AGENTS.md) |
| drivers | The `Driver` port's two implementations | [drivers](../../src/drivers/AGENTS.md) · [android](../../src/drivers/android/AGENTS.md) · [ios](../../src/drivers/ios/AGENTS.md) |
| gateway | Fleet queue, routing, forwarding to workers, relay | [gateway](../../src/gateway/AGENTS.md) · [routing](../../src/gateway/routing/AGENTS.md) |
| link | Byte channels over the uplink | [link](../../src/link/AGENTS.md) |
| agent-device | Optional edge: the agent-device daemon beside a worker, its HTTP front | [agent-device](../../src/agent-device/AGENTS.md) |
| http | HTTP frontend: routes, tokens, SSE | [http](../../src/http/AGENTS.md) |
| cli | Operator command surface | [cli](../../src/cli/AGENTS.md) |
| mcp | stdio MCP server for one agent session | [mcp](../../src/mcp/AGENTS.md) |
| simlock-client, client, admin | The typed programmatic client (`simlock/client`, `simlock/admin`) | [simlock-client](../../src/simlock-client/AGENTS.md) · [client](../../src/client/AGENTS.md) · [admin](../../src/admin/AGENTS.md) |
| lease-policy | Client-side renew timer | [lease-policy](../../src/lease-policy/AGENTS.md) |
| bus | Post-commit business events and the event file | [bus](../../src/bus/AGENTS.md) |
| ports | Every external API behind an interface, with a fake | [ports](../../src/ports/AGENTS.md) |
| host-load | CPU, memory and disk load samples | [host-load](../../src/host-load/AGENTS.md) |
| agent-identity | Default requester id for CLI and MCP | [agent-identity](../../src/agent-identity/AGENTS.md) |
| daemon-protocol | Socket framing and the protocol version | [daemon-protocol](../../src/daemon-protocol/AGENTS.md) |
| test-support | Shared test helpers | [test-support](../../src/test-support/AGENTS.md) |
| `ui/` | Web console, served by the daemon | [CONSOLE.md](../CONSOLE.md) |

## Dependencies

Arrows point from the optional to the required (architecture rule 15).
`pnpm lint` (`.dependency-cruiser.mjs`, ADR 0027) enforces each line:

| Rule | Means |
|---|---|
| `past-index` | Outside a component, import only its index file (tests may also import its testing file) |
| `core-not-leasing` | Core declares a port; the composition root connects leasing to it |
| `core-not-drivers` | Core and leasing reach a platform only through the `Driver` interface |
| `no-fs-or-process` | Core, leasing, agent-device and host-load use ports, never `fs` or `child_process` |
| `definition-is-light` | A module's definition file imports its own module only for types or by dynamic import |
| `modules-imports-little`, `modules-imports-bus-types-only` | `src/modules` imports only ports, contract and core, and the bus for types |
| `not-modules` | Core, leasing, drivers, gateway and contract import nothing from modules or module-registry |
| `not-agent-device` | Core, leasing and drivers import nothing from agent-device |
| `host-load-imports-ports-only`, `not-host-load` | host-load stands alone |
| `gateway-not-edges`, `gateway-only-dispatch` | Gateway imports no driver or frontend, and from daemon only `src/daemon/dispatch.ts` |
| `only-main-knows-gateway` | In daemon, only `src/daemon/main.ts` imports the gateway |
| `link-is-portable`, `link-imports-port-types-only` | The link uses no Node module or package, and only the types of ports |
| `contract-imports-nothing` | The contract imports nothing outside itself |

A directory under `src/` with an index file is a component. Two components
never import each other, directly or through a third.

## Flows

| Flow | Doc |
|---|---|
| A lease, from request to reclaim | [leasing](../../src/leasing/AGENTS.md) |
| A lease through a gateway | [gateway](../../src/gateway/AGENTS.md) |
| Which device a request gets | [device-selection](flows/device-selection.md) |
| Startup and stop | [startup](flows/startup.md) |
| `device.exec`, local and through a gateway | [device-exec](flows/device-exec.md) |
| agent-device through simlock | [agent-device](../../src/agent-device/AGENTS.md) |

## Rules that cut across modules

- One place enforces a rule (architecture rule 10).
- Events go out after the commit that made them true ([events.md](agent-rules/events.md)).
- Simlock destroys only what its registry owns, and never touches a leased
  device ([safety.md](agent-rules/safety.md)).
- Every external API sits behind a port with an in-memory fake (architecture rule 9).

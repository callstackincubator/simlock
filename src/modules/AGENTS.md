# Modules

Does: the contract an optional module implements, and the host that loads each turned-on module and plugs its handle into the daemon.
Entry: `index.ts` → `createModuleHost` and the contract types; `testing.ts` → `fakeModule`, `fakeWorkerContext`.
Uses: ports, contract, core; the bus for types only. Never imports: leasing, gateway, drivers, agent-device, `fs`.
Imported by: `daemon/main.ts` (the factory and types); on a gateway it is handed the gateway parts and binds each module's context to its name. Core, leasing, drivers, gateway and contract never import it.

## Files

| File         | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`   | `OptionalModuleDefinition` (with optional `http` route data, read only by the OpenAPI document, and optional `localProfile` data), `ModuleTokens`, `ModuleConfig`, `WorkerModule`, `WorkerHooks`, `ModuleLease`, `ModuleLeaseHandler` (a module's lease handler, `leaseRoute` on both sides), `ModuleLeaseSocketHandler` (`socket` on both sides: `open` answers a refusal `Response` or an accept that gets the socket), `ModuleInputs` (`WorkerContext.inputs`), `WorkerContext`, the by-shape copies |
| `host.ts`    | `createModuleHost`: checks names, loads turned-on modules (`role: "worker"` or `"gateway"`), runs hooks, collects each module's `mount` and `leaseRoute`, and on a worker `prepareLocalProfiles` (below); a gateway host runs `beforeDrain` under the same 30 s deadline                                                                                                                                                                                                                                |
| `testing.ts` | Fake module and context for tests and the conformance suite                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Rules

- A module is on only under `capabilities.<name>.enabled`; off, nothing of it is loaded and its capability reads `off`. `enabled` defaults to false; a definition with `enabledByDefault: "standalone-worker"` gets true on a worker with no `gateway.url` when no layer sets it. The loader reports those names (`loadConfigWithDefaults`), and the host hands the module `ctx.enabledByDefault`.
- Names: the capability name pattern, unique, not a core route segment or a core lease sub-route (`renew`, `exec`), at most 16 capabilities.
- Creating starts nothing. A start that fails before the socket is claimed drops created modules; after it, the normal stop runs their stop hooks.
- Hooks are direct calls. `afterSocketClaimed` is not awaited; `beforeDrain` and `beforeDriversDispose` share one 30 s budget per step; a throw is logged and the step goes on.
- A definition with `localProfile` has a file in the data directory that the worker host keeps for local agents: `prepareLocalProfiles` (awaited by `daemon/main.ts` after the socket claim and before HTTP starts) writes it with one `agent` token labelled `localProfile.tokenLabel` when `http.enabled` and the module are on, and deletes it and revokes labelled tokens otherwise, for an off module too. A failure logs one `warn` and the start goes on.
- Each by-shape type (`Module*`) has a type test in `src/daemon/module-shapes.test.ts` against its original.

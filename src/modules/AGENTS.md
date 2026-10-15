# Modules

Does: the contract an optional module implements, and the host that loads each turned-on module and plugs its handle into the daemon.
Entry: `index.ts` → `createModuleHost` and the contract types; `testing.ts` → `fakeModule`, `fakeWorkerContext`.
Uses: ports, contract, core; the bus for types only. Never imports: leasing, gateway, drivers, agent-device, `fs`.
Imported by: `daemon/main.ts` (the factory and types). Core, leasing, drivers, gateway and contract never import it.

## Files

| File         | Role                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `types.ts`   | `OptionalModuleDefinition`, `ModuleConfig`, `WorkerModule`, `WorkerHooks`, `WorkerContext`, the by-shape copies |
| `host.ts`    | `createModuleHost`: checks names, loads turned-on modules, runs hooks                                           |
| `testing.ts` | Fake module and context for tests and the conformance suite                                                     |

## Rules

- A module is on only under `capabilities.<name>.enabled`; off, nothing of it is loaded and its capability reads `off`.
- Names: the capability name pattern, unique, not a core route segment, at most 16 capabilities.
- Creating starts nothing. A start that fails before the socket is claimed drops created modules; after it, the normal stop runs their stop hooks.
- Hooks are direct calls. `afterSocketClaimed` is not awaited; `beforeDrain` and `beforeDriversDispose` share one 30 s budget per step; a throw is logged and the step goes on.
- Each by-shape type (`Module*`) has a type test in `src/daemon/module-shapes.test.ts` against its original.

# Modules

Does: the contract an optional module implements, and the host that loads each turned-on module and plugs its handle into the daemon.

## Rules

- A module is on only under `capabilities.<name>.enabled`; off, nothing of it is loaded and its capability reads `off`.
- A definition with `enabledByDefault: "standalone-worker"` is on, when no config layer sets `enabled`, only on a worker with no `gateway.url`. The config loader decides that (`loadConfigWithDefaults`), not the host; the host hands the module `ctx.enabledByDefault`.
- A module name follows the capability name pattern, is unique, and is no core route segment and no core lease sub-route. The count is capped by `MAX_CAPABILITIES` (contract).
- Creating starts nothing. A start that fails before the socket is claimed drops created modules; after it, the normal stop runs their stop hooks.
- Hooks are direct calls. `afterSocketClaimed` is not awaited. `beforeDrain` and `beforeDriversDispose` each run all modules under one deadline per step (`HOOK_DEADLINE_MS` in `host.ts`); a throw is logged and the step goes on.
- A definition with `localProfile` has a file in the data directory that the worker host keeps for local agents. `prepareLocalProfiles` runs after the socket claim and before HTTP starts. It writes the file, with one `agent` token labelled `localProfile.tokenLabel`, when `http.enabled` and the module are on; otherwise it deletes the file and revokes the labelled tokens, for an off module too. A failure logs one `warn` and the start goes on.
- A by-shape type (`Module*`) copies another module's type, so `src/modules` does not import that module. Each has a type test against its original in `src/daemon/module-shapes.test.ts`; a new one needs its own.
- `relay-channel.ts` is the one copy of what modules share on a gateway's two-way relay: the frames, the close mapping and the refusals. A module passes its path, bounds and texts; it does not frame by itself.
- The worker's heartbeat in `relay-channel.ts` must stay shorter than the gateway's `TWO_WAY_SILENCE_MS` (`gateway/relay.ts`), or a quiet session is cut as a dead worker.

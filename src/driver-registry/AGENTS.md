# Driver registry

Does: lists each driver's config section (`driverConfigEntries`): the keys a driver reads under `ios.*` or `android.*`, with their validators and defaults.
Entry: `index.ts` → `driverConfigEntries`.
Uses: core types. An entry here is a driver's definition file (`../drivers/ios/definition.ts`, `../drivers/android/definition.ts`), which loads no driver code (dependency rule `definition-is-light`).
Imported by: `daemon/main.ts`, and `cli/environment.ts` on demand, so both load a config with the same keys.

## Rules

- A new driver setting is a key in that driver's definition file (type, validator, default) and the code that reads it. Nothing in core, the contract or the daemon changes (ADR 0065).
- A new driver adds its entry here.

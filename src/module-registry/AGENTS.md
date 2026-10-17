# Module registry

Does: lists the optional modules (`optionalModules`), agent-device is its first.
Entry: `index.ts` → `optionalModules`.
Uses: `src/modules` types. A module's entry here is its definition file, which loads no module code (dependency rule `definition-is-light`).
Imported by: `daemon/main.ts`, and `cli/environment.ts` on demand, for each module's config.

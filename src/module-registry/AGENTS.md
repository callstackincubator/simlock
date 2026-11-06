# Module registry

Does: lists the optional modules (`optionalModules`), agent-device is its first.

## Rules

- An entry here is a module's definition, re-exported by that module's index. A definition loads no module code (dependency rule `definition-is-light`): the CLI reads the registry only for each module's config.

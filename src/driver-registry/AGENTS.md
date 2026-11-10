# Driver registry

Does: lists each driver's config section (`driverConfigEntries`): the keys a driver reads under `ios.*` or `android.*`, with their validators and defaults.

## Rules

- A new driver setting is a key in that driver's definition file (type, validator, default) and the code that reads it. Nothing in core, the contract or the daemon changes (ADR 0065).
- A new driver adds its entry here.
- `config.get` shows a driver's `drivers.<platform>.*` keys with the values the driver uses for the unset ones (`settingDefaults`, merged by `driversWithDefaults`). A key whose default is not known without the driver (`screenCaptureCommand`) shows only when set.
- An entry is a driver's definition file, which loads no driver code (dependency rule `definition-is-light`): the daemon and the CLI both read this list, so both load a config with the same keys.

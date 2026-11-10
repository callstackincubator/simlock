# Driver registry

Does: selects light backend config for daemon and CLI.

## Rules

- Settings live in their definition and consumer; core, contract and daemon stay unchanged (ADR 0065).
- Register definitions here, heavy modules in `daemon/backends.ts`; only the daemon loads the latter.
- Ids are platform-scoped; unknown ids fail config. Only selected settings are validated/defaulted.
- Defaulted `drivers.<platform>.*` keys also need `settingDefaults`, or unset `config get` fails.
- Definitions load no driver code (`definition-is-light`); CLI/daemon config keys match.

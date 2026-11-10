# 0072. Backends register their definition, factory and device data

- **Status:** Proposed
- **Date:** 2026-11-10
- **Context:** [ADC prototype #1471](https://github.com/callstackincubator/simlock/pull/1471) and its [architecture feedback](https://github.com/callstackincubator/simlock/pull/1471#issuecomment-6770222478)
- **Extends:** [ADR 0065](0065-a-driver-owns-its-config-keys-and-a-module-takes-the-sections-it-reads.md)
- **Narrows:** ADR 0061's assumption that every virtual backend supplies saved sources; a backend declares whether it supports baselines.

## Context

The ADC prototype works through the existing agent and gateway surfaces, but
adding it changes discovery, prerequisite selection, state loading and device
lifecycle code. Another provider would need to edit those places again.

State loading currently selects one data table per platform. Selecting a
different Android implementation can make the previous implementation's rows
unreadable. A device's owner must remain the implementation that created it.

## Decision

### Definitions and modules have separate registries

`BackendDefinition` is light data: an id, platform, configuration defaults and
validators, and capabilities. The CLI and config loader use the light registry.
They import no driver implementation. Settings for `drivers.<platform>.*` and
runtime settings under the platform section are selected by the backend.

`BackendModule` supplies the definition, a device-data table, prerequisites and
the driver factory. The daemon's heavy registry imports these modules. Discovery
selects a module by platform and configured backend id, builds its context once,
then runs the same prerequisite/factory flow for every implementation. Unknown
backend ids are configuration errors.

```mermaid
flowchart LR
  Definition[Backend definition] --> Light[Light registry]
  Light --> Config[CLI and config loader]
  Module[Backend module] --> Heavy[Daemon registry]
  Definition --> Module
  Heavy --> Discovery[Generic discovery]
  Discovery --> Driver[Selected driver]
  Heavy --> Tables[All device-data tables]
```

Local Android and iOS use the explicit id `local`. Omitting the backend setting
selects that definition. One backend per platform is active on a worker.
Only the local implementations are registered in the first step.

### Implementation sequence

The registry change registers only local Android and iOS. It extracts their
existing factories and keeps device records, table keys and the daemon protocol
unchanged. Capabilities are metadata in this step.

Before another backend is registered, follow-up changes must preserve device
ownership across backend selection, then preserve baseline/source ownership and
enforce capabilities at common admission paths. Those changes need their own
state migrations and tests; they are not implemented by the registry extraction.

This decision adds no provider deadline or renewal mechanism. Simlock's
TTL-first agent lease remains governed by ADR 0004.

## Consequences

- A backend adds its own folder, a light registry entry and a heavy registry
  entry. Public settings and behavior are documented with that backend.
- A backend's heavy entry is its component's `index.ts`. Backend subcomponents
  under a platform driver have their own import boundary; the platform driver
  does not own their private files. Other module boundaries keep their existing
  entry points. Definitions remain separate light entry points.
- Shared backend context carries ports, host facts, capture artifacts, logging
  and diagnostic callbacks. Drivers do not depend on the daemon or event bus.

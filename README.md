# Pitlane

Pitlane leases iOS simulators and Android emulators to parallel coding agents.

```sh
pnpm install
pnpm build
pitlane lease --platform ios --device "iPhone 16" --detach --json
pitlane status --json
```

The daemon starts on demand. Use `pitlane doctor` to reconcile managed state,
and `pitlane nuke --yes --delete-devices` only for an emergency reset of
Pitlane-managed devices.

Running devices are limited independently from the number of managed devices.
All values are positive integers; omitted running limits default to the derived
managed limits (and their global sum).

```json
{
  "limits": {
    "maxRunning": 3,
    "ios": { "maxDevices": 4, "maxRunning": 2 },
    "android": { "maxDevices": 2, "maxRunning": 2 }
  }
}
```

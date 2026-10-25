# Drivers

Does: the platform half of every device verb — one driver per platform, serving its virtual and physical devices.
Entry: `daemon/main.ts` `discoverDrivers` → `IosSimctlDriver.create` (macOS only), `AndroidDriver.create`. `SIMLOCK_DRIVERS_MODULE` replaces both.
Uses: core, ports. Never imports: bus, contract, leasing, gateway, daemon. Imported by: daemon only.
Manuals: [Android](android/AGENTS.md), [iOS](ios/AGENTS.md). Flows: [device selection](../../docs/internal/flows/device-selection.md).

## The interface core speaks (`core/driver.ts` `Driver`)

| Verbs                                                                    | Contract                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `resolveSpec`                                                            | Exact request → spec. Never downloads: throws `RuntimeMissingError` with `component` when a download could fix it |
| `provision`, `makeReady`, `reclaim`, `shutdown`, `destroy`               | Lifecycle. `makeReady` returns a freshly read `address`; `reclaim` returns `ready` or `shutdown`                  |
| `listManaged`, `revalidateRoot`, `findLegacy`, `destroyLegacy`           | What the root holds; re-proof before a purge; pre-root devices                                                    |
| `listCatalog`, `estimate`, `advisories`, `toolVersions`                  | Read-only facts for catalog, ETAs, `doctor`, `status`                                                             |
| `findComponent`, `installComponent`, `listComponents`, `removeComponent` | Runtimes / system images. Only core's `ComponentInstaller` installs or removes                                    |
| `inspectPhysical`, `listPresentPhysical`                                 | Enrollment read and presence of physical devices                                                                  |
| `leaseEnvironment`, `virtualLeaseEnvironment`, `passthrough`             | What a holder needs to reach its device                                                                           |
| `dispose`                                                                | Daemon stop. Android reaps its adb server here                                                                    |
| `screenCapture` (optional)                                               | A device's screen as core's frame envelope (`core/screen.ts`); absent = cannot stream                             |

## Rules both drivers keep

1. **Owned root** (ADR 0001) — `create` calls `ensureOwnedRoot` (`core/device-root.ts`): when
   nothing is there it creates the root with `.simlock-owned.json`; otherwise the marker must
   name this instance and platform; anything else refuses. Key `drivers.<platform>.deviceRoot`
   (absolute), default `$SIMLOCK_HOME/devices/<platform>`.
   A refusal (`OwnedRootError`) skips that platform only and emits `driver.root-rejected`.
2. **Scope every command to the root.** Ownership is membership in the root, never a name prefix.
3. **Opaque to core.** `address`, `driverData`, `deviceRoot` and `drivers.<platform>.*` are carried unread. Each driver package exports a `DeviceDataTable` (`iosDeviceDataTable`, `androidDeviceDataTable`) that stores its `driverData` in its own `state.db` table, built without a driver instance so it loads where the driver is refused; `daemon/main.ts` `productionDeviceDataTables` passes both on every host.
4. **Prerequisites** — `iosPrerequisites`, `androidPrerequisites` return a `PrerequisiteCheck`, not a
   `Driver` method; built even when the driver did not start, run only by `doctor`.
5. **Installers** — `installer-process.ts`: `runInstallerProcess` parses `%` progress from both
   streams, SIGTERM on abort, SIGKILL 10 s later. `runBoundedProcess` adds a deadline.
6. **Passthrough** — the driver owns the scoping flags and the refused verbs
   (`PassthroughRefusedError`). `DriverCatalog.passthrough` routes by `passthroughTools`.
   With a device (`device.exec`) the driver also fills the lease's device in and refuses a
   command naming another, through `other-device-refusal.ts` (ADR 0047).
   `hasTerminal: false` means `device.exec`: refuse what needs a tty.
7. **Lease environment** — set on the lease at grant from `leaseEnvironment`; values are per platform.
8. **Facts reach the bus through callbacks.** A driver never imports the bus; `daemon/main.ts`
   bridges its constructor callbacks. Today only iOS `onSlimmed` → `device.slimmed`. Android `onDiagnostic` goes to the logger as
   warnings (`logAndroidDiagnostic`), not the bus.

## Known gaps

- **A root is an accident boundary, not a security boundary.** `simctl --set <root>` or a raised
  `ADB_LOCAL_TRANSPORT_MAX_PORT` reaches in. Any lease holder can name another Simlock device
  in `adb -s` / `simctl`. Mutually untrusted agents need OS-level isolation.
- **Ownership is proven at startup and trusted for the daemon's life.** A root swapped by `mv` or a
  symlink is not noticed by reports. Only `doctor --purge-orphans` re-proves (`revalidateRoot`)
  before destroying. A restart re-proves everything.
- **Physical devices have no accident boundary.** Any host tool sees them; an app another agent
  installs is uninstalled on reclaim. Re-enrol (`simlock device add`) after a deliberate install.

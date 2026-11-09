# Drivers

Does: the platform half of every device verb — one driver per platform, serving its virtual and physical devices.
Flows: [device selection](../../docs/internal/flows/device-selection.md), [Android](android/AGENTS.md), [iOS](ios/AGENTS.md).

## Rules

What core may assume of a driver (`core/driver.ts` `Driver`):

- `resolveSpec` never downloads: it throws `RuntimeMissingError` with `component` when a download could fix it.
- Core calls `reclaim` for a physical device only. A virtual device is destroyed when its lease ends, and both drivers throw on its `reclaim`.
- A local source (ADR 0061) is never leased; a seed is copied into every local virtual device. A cloud provider owns the clean-image preparation and may refuse saved baselines.
- Only core's `ComponentInstaller` installs or removes a component.

What both drivers keep:

- **Owned root** (ADR 0001). `create` calls `ensureOwnedRoot` (`core/device-root.ts`): when nothing is there it creates the root with `.simlock-owned.json`; otherwise the marker must name this instance and platform; anything else refuses. The key is `drivers.<platform>.deviceRoot` (absolute). A refusal (`OwnedRootError`) skips that platform only and emits `driver.root-rejected`.
- **Scope every command to the root.** Ownership is membership in the root, never a name prefix. iOS only: under `drivers.ios.deviceSet: "default"` (ADR 0048) simulators stay in Xcode's set with no owned root, and a device is this instance's only when its durable mark names the instance id.
- **Opaque to core.** `address`, `driverData`, `deviceRoot`, `drivers.<platform>.*` and the keys a driver's definition file declares under `ios.*` or `android.*` are carried unread.
- A driver's `DeviceDataTable` is built without a driver instance, so a device loads where its driver is refused; `productionDeviceDataTables` (`daemon/driver-discovery.ts`) passes both tables on every host.
- A driver imports only core and ports: never the bus, the contract, leasing, the gateway or the daemon. No lint rule holds this.
- Cloud devices are owned by their durable allocation record and API origin. Neither a cloud device name nor an account-wide device listing grants ownership.
- **Facts reach the bus through callbacks.** `daemon/driver-discovery.ts` bridges a driver's constructor callbacks to an event or to the logger.
- **Prerequisites** (`iosPrerequisites`, `androidPrerequisites`) are no `Driver` method: they are built even when the driver did not start, and only `doctor` runs them.
- **Passthrough.** The driver owns the scoping flags and the refused verbs (`PassthroughRefusedError`). With a device (`device.exec`) it also fills the lease's device in and refuses a command naming another, through `other-device-refusal.ts` (ADR 0047). `hasTerminal: false` means `device.exec`: refuse what needs a tty.

## Known gaps

- **A root is an accident boundary, not a security boundary.** `simctl --set <root>` or a raised
  `ADB_LOCAL_TRANSPORT_MAX_PORT` reaches in. Any lease holder can name another Simlock device
  in `adb -s` / `simctl`. Mutually untrusted agents need OS-level isolation.
- **Ownership is proven at startup and trusted for the daemon's life.** A root swapped by `mv` or a
  symlink is not noticed by reports. Only `doctor --purge-orphans` re-proves (`revalidateRoot`)
  before destroying. A restart re-proves everything.
- **Physical devices have no accident boundary.** Any host tool sees them; an app another agent
  installs is uninstalled on reclaim. Re-enrol (`simlock device add`) after a deliberate install.

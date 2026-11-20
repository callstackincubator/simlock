# iOS driver

Does: simulators in an owned `simctl` device set, slimmed on request, and USB iPhones and iPads via `devicectl`.
Flows: [device selection](../../../docs/internal/flows/device-selection.md), [drivers](../AGENTS.md), [input](input/AGENTS.md).

## Rules

The device set:

- Under `drivers.ios.deviceSet: simlock`, never `simctl` without `--set`, except three unscoped calls: `findLegacy`, `destroyLegacy`, and the read-only `simctl list -j devices` of `listComponents`.
- Under `default` (ADR 0048) the set is Xcode's own: never `--set`, no owned root, and never act on a device whose durable mark does not name this instance. `listManaged` lists only those, and `findLegacy` answers `undefined`.
- `ios.simulator.headless: false` needs `default`: the `simlock` set has no DeviceHub, so iOS is refused (`invalid-device-set`). Simulators left in the set given up refuse iOS too (`device-set-changed`); that check reads files only.
- The erasable mark is written before the durable one, never both at once. Under `default` a failed mark write deletes the new simulator first.

Resolve and boot:

- A slim spec is returned only for a slim request the driver will slim. The registry alone records a device's mode.
- `RuntimeMissingError` is only for what a download can fix: an OS outside the device type's range, an installed runtime not paired with the type, and anything below iOS 16 are refused instead.
- A boot is `simctl rename` (prepare only: label, else stored name; failure logged), `simctl boot`, `bootstatus -b`, then `listapps` until it succeeds, on one deadline: bootstatus can finish before the installer is ready.
- Slim (ADR 0060), on `prepare` of a slim spec only: the managed labels are merged into the simulator's `disabled.plist` before the boot (other entries kept; a failed write is logged, the boot goes on), and `launchctl print-disabled system` is read back after it. A label not as written is `full`; a failed readback is `slim`; both call `onSlimSkipped`, logged only. All as written and the write ok: `slim`, and `onSlimmed` is `device.slimmed`. Nothing written off and no kept category: `full`, no readback.
- Named services (ADR 0083): `exclude` beats `include` beats a category; `simlock-managed.json` records the names, so one dropped from both is written back on. A baseline saved before it keeps a dropped name off; `include` it.
- Slim `except` (ADR 0066): an excepted category's labels are written `false`; an unknown name is `BAD_REQUEST`; a kept label not read back throws `KeptCategoriesError`.
- A recovery boot writes no slim overrides and reads nothing back. DeviceHub clipboard isolation is configured before preparation and recovery boots; ready default-set simulators reboot under the lease claim before a grant. Active leases at upgrade keep clipboard sync until a later boot or lease end.
- The overrides folder lives outside the device set (`launchdOverridesRoot`), so `destroy` removes it itself after `simctl delete`.
- After every boot and before the readback, `runAfterBoot` (`boot-courtesies.ts`) runs the volume step, then the window step. Each only reports its failure (`onSilenceFailed`, `onWindowFailed`).
- Volume (`ios.simulator.audio: false`): apps play at volume 0. A baseline source is not silenced.
- Window (`ios.simulator.headless: false`): DeviceHub is opened in the background and leaves started devices running when it quits. Only a non-zero exit of that open means it is missing: Simulator.app is then opened, detached.

Seeds (ADR 0061):

- A simulator is a clone of its kind's seed. A seed is known by its `ios_source_data` row, never by name, and lives in the sources set: `sources` in the owned set, an owned root of its own under `default`. It is in no `listManaged` or `simlock simctl list`.
- A seed is made from a throwaway (ADR 0076): `simlock-seed-<id>` is booted once, shut down, cloned unbooted into the sources set, then deleted with its log folder; `saveSource` deletes the saved-from lease's log folder too. A log folder that cannot be deleted is logged and the make or save goes on; a throwaway that cannot be deleted fails the make.
- A source records its lineage and, in `ios_source_files`, the files and links naming it, after flushing its WALs. A clone keeps its source's lineage and, before its first boot, has its `com.apple.LaunchServices-*.csstore` deleted and those files and links swapped to its own UDID; a failed drop or swap deletes it. No lineage: a seed is remade, a baseline stale.
- Two provisions of a kind make one seed; clones of a seed and its deletion take turns.
- A `clone` or `create` waits `ios.simulator.createTimeoutMs`. At the limit it fails but `simctl` runs on: the UDID it later prints is deleted, the seed's deletion waits for it, and 5 silent minutes more kills and logs it.
- A `making` row of another process is swept at the first `listSources`, with its throwaway; one of this process, once older than any make takes, at the next make of its kind.
- A seed `simctl delete` calls `Invalid device` is gone: its row is dropped. `removeComponent` deletes the runtime's seeds first.

Physical, passthrough, screen:

- `devicectl` over `device.exec` is an allow-list (`devicectlExecCommand`): what is not on the reviewed list is refused, and so is every option that names a host path.
- Screen (`screen-capture.ts`): stdout is the frames, stdin the program's liveness, and closing stdin is the stop. Key frames keep coming on a still screen. The daemon's own `SIMLOCK_IOS_DEVICE_SET` and `SIMLOCK_COREDEVICE_INFO_PLIST` reach neither program; the driver sets the first for a `simlock`-set simulator only.
- An iPhone below iOS 27 is `ScreenUnavailableError`; an unreadable version goes on. The iPhone program enforces its CoreDevice pin: another major exits 69, a 503 for the viewer.

Tunnels (`device-tcp.ts`):

- A simulator has no network of its own: its sockets are the worker's loopback sockets. A listener is the lease's only when a word of its process's environment is exactly `SIMULATOR_UDID=<the lease's UDID>`, checked on every connection.
- `reverse` listens on the device port itself on both loopbacks, and is refused `TUNNEL_PORT_IN_USE` when anything answers on either, a wildcard listener included.
- No rule sits on a simulator: `sweep` does nothing, and a `reverse`'s `close` sets `holdsDeviceRule: false`, so a lease end with an aborted signal still runs it.

## Known gaps

- **A restart between `simctl clone` and the durable mark under `default` (#968)** leaves one unlisted `simlock-<id>` simulator in Xcode's set. Delete it with `simctl delete`.
- **Runtime downloads outlive deletion (#79).** Reclaim them in Xcode → Settings → Platforms.
- **Slim costs (#87, #172).** Below iOS 18.5 a slim request gets `full`. Slim devices lose push, Spotlight, StoreKit, universal links, Siri, iCloud sync; use `--mode full`.
- **The overrides file is undocumented.** If Apple ignores it, the readback grants `full`.
- **A recovered slim device runs full but is recorded `slim` (#174)** until its next `makeReady`.
- **A cold slim lease takes a full cold boot;** MCP clients need a longer timeout.
- **A screen stream can freeze after a reboot under its lease:** the capture checks the boot only at start; reopen the Screen tab.
- **An iPhone's rotation has not run on hardware**; only a Duo's panel switch is proven.
- **A foldable's stream follows SpringBoard's `DisplayContentMode` log** (ADR 0075): another wording leaves it, and taps, on the panel picked at open; a tap between a fold and the new size lands on the old panel.
- **A capture killed by SIGKILL cannot stop its CoreDevice stream**, and neither can a stop while `startMediaStream` runs past its limit.
- **A new Xcode major turns iPhone streams off** until `vendor/screen-capture/Stubs/` is checked against it and the pin moves.
- **Untested on an iPhone:** DeviceHub or Xcode showing the same device during a stream; the holder's `devicectl` commands during one; `stop()` ending the stream.

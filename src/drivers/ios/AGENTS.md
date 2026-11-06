# iOS driver

Does: simulators in an owned `simctl` device set, slimmed on request, and USB iPhones and iPads through `devicectl`.
Flows: [device selection](../../../docs/internal/flows/device-selection.md), [drivers](../AGENTS.md), [input](input/AGENTS.md).

## Rules

The device set:

- Under `drivers.ios.deviceSet: simlock`, never `simctl` without `--set`, except three unscoped calls: `findLegacy`, `destroyLegacy`, and the read-only `simctl list -j devices` of `listComponents`.
- Under `default` (ADR 0048) the set is Xcode's own: never `--set`, no owned root, and never act on a device whose durable mark does not name this instance. `listManaged` lists only those, and `findLegacy` answers `undefined`.
- `ios.simulator.headless: false` needs `default`: the `simlock` set has no DeviceHub, so iOS is refused (`invalid-device-set`). Simulators left in the set being given up refuse iOS too (`device-set-changed`); that check reads files only, never `simctl`.
- The erasable mark is written before the durable one, never both at once. Under `default` a failed mark write deletes the new simulator before the error is rethrown.

Resolve and boot:

- A slim spec is returned only for a slim request the driver will slim. The registry is the only record of a device's mode.
- `RuntimeMissingError` is only for what a download can fix: an OS outside the device type's range, an installed runtime not paired with the type, and anything below iOS 16 are refused instead.
- A boot is `simctl boot`, `bootstatus -b`, then `listapps` until it succeeds, on one deadline: bootstatus can finish before the installer accepts requests.
- Slim (ADR 0060), on `prepare` of a slim spec only: the managed labels are merged into the simulator's `disabled.plist` before the boot (other entries kept; a failed write is logged and the boot goes on), and `launchctl print-disabled system` is read back after it. A label not as written returns `full`; a readback that fails returns `slim`; both call `onSlimSkipped`, logged only. Every label as written and the write ok: `slim`, and `onSlimmed` becomes `device.slimmed`.
- Slim `except` (ADR 0066, `slim-except.ts`): an excepted category's labels are written `false`; an unknown name is `BAD_REQUEST`; a kept label not read back throws `KeptCategoriesError`.
- A recovery boot writes no overrides and reads nothing back.
- The overrides folder lives outside the device set (`launchdOverridesRoot`), so `destroy` removes it itself after `simctl delete`.
- After every boot and before the readback, `runAfterBoot` (`boot-courtesies.ts`) runs the volume step, then the window step. Each only reports its failure (`onSilenceFailed`, `onWindowFailed`), and the device stays in use.
- Volume (`ios.simulator.audio: false`): the step sets the volume state inside the simulator and reads nothing back. Apps keep playing, at volume 0. A baseline source's boot is not silenced: a copy's own `makeReady` does it.
- Window (`ios.simulator.headless: false`): DeviceHub is opened in the background, so the front app stays in front, and is told not to shut down started devices when it quits. Only a non-zero exit of that open means DeviceHub is missing: Simulator.app is then opened instead, detached, so quitting it leaves the simulator running. Any other failure opens nothing.

Seeds (ADR 0061):

- A simulator is a clone of its kind's seed. A seed is known by its `ios_source_data` row, never by name, and lives in the sources set: `sources` in the owned set, an owned root of its own under `default`. It is in no `listManaged` and no `simlock simctl list`.
- Every clone (a seed's copy, `saveSource`'s own clone, a `provision` with `source`) has its `data/var/db/lsd/com.apple.LaunchServices-*.csstore` deleted before its first boot: it records each app, system apps included, under the original device's folder. A clone whose drop fails is deleted.
- Two provisions of a kind make one seed; clones of a seed and its deletion take turns.
- A `making` row of another process is swept at the first `listSources`; one of this process, once older than any make takes, at the next make of its kind.
- A seed that `simctl delete` reports as `Invalid device` is already gone, so its row is dropped.
- `removeComponent` deletes the runtime's seeds first.

Physical, passthrough, screen:

- `devicectl` over `device.exec` is an allow-list (`devicectlExecCommand`): what is not on the reviewed list is refused, and so is every option that names a host path.
- Screen (`screen-capture.ts`): stdout is the frames, stdin the program's liveness, and closing stdin is the stop. The daemon's own `SIMLOCK_IOS_DEVICE_SET` and `SIMLOCK_COREDEVICE_INFO_PLIST` reach neither program; the driver sets the first for a simulator under `simlock` only.
- An iPhone below iOS 27 is `ScreenUnavailableError`; an unreadable version goes on. The iPhone program enforces its CoreDevice pin itself: another major exits 69 with the reason, a 503 for the viewer.

Tunnels (`device-tcp.ts`):

- A simulator has no network of its own: its sockets are the worker's loopback sockets. A listener is the lease's only when a word of its process's environment is exactly `SIMULATOR_UDID=<the lease's UDID>`, checked on every connection.
- `reverse` listens on the device port itself on both loopbacks, and is refused `TUNNEL_PORT_IN_USE` when anything already answers on either, a wildcard listener included.
- No rule sits on a simulator: `sweep` does nothing, and a `reverse`'s `close` sets `holdsDeviceRule: false`, so a lease end with an aborted signal still runs it.

## Known gaps

- **A restart between `simctl clone` and the durable mark under `default` (#968)** leaves one unlisted `simlock-<id>` simulator in Xcode's set. Delete it with `xcrun simctl delete <udid>`.
- **A runtime download outlives the runtime (#79).** `simctl runtime delete` leaves its asset bundle in `/System/Library/AssetsV2`. Simlock never deletes it; `doctor` and `component remove` report it. Reclaim in Xcode → Settings → Platforms.
- **Slim costs (#87, #172).** Below iOS 18.5 a slim request gets `full`. Slim devices lose push, Spotlight, StoreKit, universal links, Siri, iCloud sync. Use `--mode full` when a test needs them.
- **Folders of simulators deleted before ADR 0060 stay** in `/private/var/tmp`.
- **The overrides file is an undocumented CoreSimulator file.** If Apple ignores it, the readback grants `full`.
- **A recovered slim device runs full but its record says `slim` (#174)** until its next `makeReady`.
- **A cold slim lease takes a full cold boot.** MCP clients need `resetTimeoutOnProgress` or a longer timeout.
- **Two simulators made ready at once on the Simulator.app path:** the second may get no window and no warning.
- **A screen stream can freeze after a reboot under its lease.** The capture program checks the simulator is booted only when it starts, so after the health monitor reboots a crashed simulator the viewer sees the old picture until the Screen tab is reopened.
- **An iPhone rotated mid-stream keeps the first picture's scale**, as a simulator does: the scaler is sized once. An iPhone that stays connected but stops sending video shows the last picture until the lease ends.
- **A capture killed by SIGKILL cannot stop its CoreDevice stream**; CoreDevice is left to notice its client is gone. The same for a stop while `startMediaStream` is still running past its limit.
- **A new Xcode major turns iPhone streams off** until `vendor/screen-capture/Stubs/` is checked against that release and the pin moves.
- **Untested on an iPhone:** DeviceHub or Xcode showing the same device during a stream; the holder's `devicectl` commands during one; the source ending after the first picture; `stop()` really stopping the stream. Nothing can observe CoreDevice's state, so the slow lane proves only that the process is gone and the device streams again. Two viewers of one lease ask for two streams (#602).

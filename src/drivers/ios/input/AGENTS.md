# iOS device input

Does: taps, scrolls, Home, the app switcher, Lock, keys and rotations on an iOS simulator, through `simlock-screen-capture <udid> --input`; a physical iPhone answers unavailable.
Flows: [iOS driver](../AGENTS.md), [input](../../../input/AGENTS.md).

## Rules

- The helper's HID client stays here; core and the input module do not name it.
- Home is `xcrun simctl` here and nowhere in the helper (one owner). Home launches `com.apple.springboard`; a failure is only logged. `app_switcher` and `lock` go to the helper (ADR 0085): Lock is one Indigo button press, the app switcher two Home presses 50 ms apart. Back is dropped.
- Keys go to the helper on every runtime, and the config never says `keyboardUnavailable` (ADR 0085). A press the guest ignores is not detected.
- The helper follows the driver's device-set rule: `SIMLOCK_IOS_DEVICE_SET` names the owned set under `simlock` and is absent under `default`. The daemon's own value never reaches it.
- The open waits for the helper's first size frame (`READY_DEADLINE_MS` in `device-input.ts`), which it writes once its HID client is set up. A missing program, an early exit or no frame rejects the open, and the helper is stopped.
- The config is always `portrait`, a rotation included: it is the size of the panel the taps land on. A foldable's helper sends the size again when the panel in use changes (ADR 0075 §4); a size equal to the held one is no change, and a frame that is not a size is warned about and kept out.
- The helper follows the panel in use the way the capture does, through the same `PanelFollower`: taps go to that panel's digitizer, the inner panel's turned upright.
- A rotation goes to the helper on every runtime. The helper sends it as a GSEvent to the simulator's `PurpleWorkspacePort` and logs one it could not send.
- A physical iPhone answers `{unavailable}` and starts nothing.

## Known gaps

- **A CoreSimulator older than 1174.21 was not measured** for the Home and Lock presses (ADR 0085); a worker on one may ignore them silently.
- **A screen that does not rotate ignores a rotation, and nothing tells the client** (the iPhone home screen, upside down on a Face ID iPhone). Rotation was checked on Xcode 26.4 (iOS 26.4 runtime) and Xcode 27.0 (iOS 26.4 and 27.0 runtimes) (#1080).
- **A one-panel device's input follows its native frame**, so after a rotation taps and picture stay in the same frame; a foldable's follow the upright picture.
- **Taps may vanish after a reboot under the lease.** After the health monitor reboots a crashed simulator the helper's HID client is bound to the old boot, until the lease's input reopens.

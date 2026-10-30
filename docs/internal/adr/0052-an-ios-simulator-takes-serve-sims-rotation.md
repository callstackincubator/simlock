# 0052. An iOS simulator takes serve-sim's rotation

- **Status:** Proposed
- **Date:** 2026-10-30
- **Issue:** [#1080](https://github.com/callstackincubator/simlock/issues/1080)
- **Narrows:** [ADR 0049](0049-a-lease-holder-watches-and-drives-its-devices-screen.md)
  §3 ("Rotation (`0x07`) is dropped on every platform"), its consequence
  "A person cannot rotate a device through Simlock", and its rejected
  alternative "Rotation through Simulator.app or CoreDevice on iOS, and
  through `user_rotation` on Android".

## Context

ADR 0049 dropped `0x07` everywhere: on 2026-10-26, on Xcode 27, serve-sim's
GSEvent through `PurpleWorkspacePort` was accepted but did not rotate a
simulator, and agents could rotate through agent-device instead.

#1080 shows the second half does not hold: after agent-device rotates a
leased iPhone simulator to landscape, taps land on the wrong control. On
2026-10-30, on Xcode 26.4 with an iOS 26.4 runtime, the same GSEvent sent
by the vendored helper rotated a simulator in Simlock's device set with
Simulator.app not running, and HID touches through the helper's input mode
then landed where the controls were drawn.

## Decision

1. `0x07 {"orientation"}` with one of serve-sim's four names (`portrait`,
   `portrait_upside_down`, `landscape_left`, `landscape_right`) is an input
   message. Another name is dropped, as serve-sim drops it.
2. An iOS simulator's device input forwards it to its helper on every
   runtime, which sends serve-sim's GSEvent. A send the guest ignores
   (Xcode 27) is not detected and nothing tells the client.
3. Android and physical iPhones keep dropping it. A physical iPhone takes no
   input at all; on Android, scrcpy's only rotation toggles between two
   rotations through the window manager's rotation lock and cannot name the
   four orientations.
4. `0x82` keeps saying `portrait` after a rotation, and positions stay
   fractions of the device's native frame, as the helper already maps them.

## Consequences

- A lease holder on Xcode 26 can drive a landscape-only app on an iOS
  simulator through Simlock's own input.
- The platforms differ: the same `0x07` turns an iOS simulator and does
  nothing on Android. ADR 0049 rejected that for an Android-only rotation;
  here the platform that needs it (agent-device's rotation leaves iOS taps
  wrong) gets it.
- On Xcode 27 a rotation is a silent no-op until #1024 finds a path.
- No protocol change: the input socket's messages are not a contract shape.

## Alternatives considered

- **Drop rotation on iOS 27 runtimes, as keys are.** Rejected: the failure
  was seen with Xcode 27, not tied to the runtime, and `0x82` has no flag
  to say rotation is unavailable.
- **Report the new orientation in `0x82`.** Rejected: the helper's touch
  frame does not change after a rotation, so a client told `landscape_*`
  would map taps into a frame the helper does not use.

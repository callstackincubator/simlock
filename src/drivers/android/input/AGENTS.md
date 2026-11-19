# Android device input

Does: taps, scrolls, keys and buttons on an Android emulator or a leased phone, through a control-only scrcpy server.
Flows: [Android driver](../AGENTS.md), [screen](../screen/AGENTS.md), [input](../../../input/AGENTS.md).

## Rules

- Every adb command and connection goes through the device's target, the same `ScreenTarget` the [screen](../screen/AGENTS.md) uses; this module names no port and runs no check.
- It changes no device setting: no `stay_awake`, `power_on=false`, and a dark screen is not woken.
- It touches only its own `scid`; the stream's server on the same device is another socket and jar.
- A phone's closed check is not a failed open: `open` resolves `{unavailable: <message>}` with nothing pushed. A push that adb ran and failed rejects.
- The control socket is read and discarded, so it never fills. Its end, unless `close` ran, goes to `onFailed`: that is how a dead server is noticed.
- The size is `cur=` of display 0 in `dumpsys window displays`, the size in the current rotation, and it is read again on a timer. A failed read keeps the last size and is logged once until a read succeeds.

## Known gaps

- **A rotation (`0x07`) is dropped.** scrcpy's only rotation toggles between two, so it can name neither upside down nor a landscape side.
- **Text messages are not handled; key layouts are US.** A key outside the table in `keycodes.ts` is dropped.

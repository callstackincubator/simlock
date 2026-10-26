# Android device input

Does: taps, scrolls, keys and buttons on an Android emulator or a leased phone, through a control-only scrcpy server.
Entry: `index.ts` → `createAndroidDeviceInput(options)`, built by `AndroidDriver` as its `input` when `create` got
`scrcpyServerPath` and `tcpStreamConnector`. It is the implementation of core's `DeviceInputFactory` (`core/input.ts`).
Uses: core (`DeviceInput`, `InputMessage`), ports (`Clock`, `Logger`), the [screen](../screen/AGENTS.md) module's `ScreenTarget`,
push, socket connect and exit wait. Parent: [Android driver](../AGENTS.md). Consumer: [input](../../../input/AGENTS.md).

## Files

| File              | Role                                                       |
| ----------------- | ---------------------------------------------------------- |
| `index.ts`        | `createAndroidDeviceInput`, entered only here              |
| `device-input.ts` | One input: open, send, size poll, failure, close           |
| `display-size.ts` | `dumpsys window displays` → the `cur=<w>x<h>` of display 0 |
| `packets.ts`      | scrcpy control packets: touch (2), scroll (3), keycode (0) |
| `keycodes.ts`     | USB HID usage → Android keycode, modifier meta bits        |

## How it works

1. `open(device, signal)`: the device's target, then `dumpsys window displays` (10 s). A closed phone check throws
   `ScreenUnavailableError` and `open` resolves `{unavailable: <message>}`, with nothing pushed. No `cur=` line, a size
   of 0 or a failed read rejects.
2. Push the jar to `/data/local/tmp/simlock-scrcpy-<scid>.jar` (30 s), start `com.genymobile.scrcpy.Server 5.0.1` with
   `video=false audio=false control=true power_on=false send_dummy_byte=true cleanup=true tunnel_forward=true`, connect
   `scrcpy_<scid>` (15 s from the spawn, retry 100 ms) and read the dummy byte. Past 15 s, a shell that exits or a push
   that fails rejects, after the close below.
3. Every 2 s, one size read (the next is scheduled when one ends); a different size goes to `onConfig`. A failed read keeps
   the last size and is logged once (a `warn` through the driver's `logger`) until a read succeeds. `onConfig` calls a listener at once with the current size; orientation is `landscape_left` when wider.
4. `send`: a position is `round(fraction × size)` capped at `size - 1`, in a 32-byte touch packet (finger -2, pressure
   full except on `end`). Scroll: wheel units `clamp(round(d × 16), -16, 16)`, vertical `+dy`, horizontal `-dx`, at the
   given point or the centre. Buttons: Home 3, Recents 187, Power 26, Back 4, down then up. Keys: the HID table in
   `keycodes.ts`; an unknown usage is dropped; a modifier (0xe0-0xe7) is sent as its own key and held in the meta state
   from its down to its up.
5. The control socket is read and discarded; its end, unless `close` ran, goes to `onFailed`.
6. `close` (idempotent, 5 s): stop the poll, close the socket, wait 1 s for the shell, SIGKILL it, `rm -f` the jar.

## Rules

- Every adb command and connection goes through the device's target; this module names no port and runs no check.
- It changes no device setting: no `stay_awake`, `power_on=false`, and a dark screen is not woken.
- It touches only its own `scid`; the stream's server on the same device is another socket and jar.
- Rotation (`0x07`) and text messages are not handled; key layouts are US.

# Android screen capture

Does: an Android emulator's screen as core's screen frames, through the vendored scrcpy server and our own client.
Entry: `index.ts` → `createAndroidScreenCapture(options)`, built by `AndroidDriver` as its `screenCapture` when `create`
gets `scrcpyServerPath` and `tcpStreamConnector` (`daemon/main.ts` passes the jar `pnpm build` copies to dist/vendor/scrcpy).
Uses: core (`ScreenCapture`, frame encoder), ports (`ProcessRunner`, `TcpStreamConnector`, `Clock`), `../adb-host-protocol.ts`.
Parent: [Android driver](../AGENTS.md). Consumer: [stream](../../../stream/AGENTS.md).

## Files

| File              | Role                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `index.ts`        | `createAndroidScreenCapture`: the driver's `ScreenCapture`, entered only here  |
| `session.ts`      | One stream: push, server, socket, body, close                                  |
| `adb-socket.ts`   | `openDeviceSocket`: `host:transport` + `localabstract` on Simlock's adb server |
| `scrcpy-video.ts` | `ScrcpyVideoParser`: scrcpy's video socket (codec id, session, media packets)  |
| `h264.ts`         | Annex-B split, AVCC, the `avcC` record                                         |
| `envelope.ts`     | `EnvelopeMapper`: scrcpy events → core's screen frames                         |

## How it works

1. Physical → `ScreenNotSupportedError`. Jar missing at `scrcpyServerPath` → `ScreenUnavailableError`
   (`unavailable()` gives the same reason). No serial (not running) → `ScreenUnavailableError`.
2. `scid`: random 31-bit, written `%08x`. `adb -s <serial> push <jar> /data/local/tmp/simlock-scrcpy-<scid>.jar`.
3. `adb -s <serial> shell CLASSPATH=<that path> app_process / com.genymobile.scrcpy.Server 5.0.1 scid=<scid>
log_level=info tunnel_forward=true video=true audio=false control=false video_codec=h264
send_device_meta=false send_dummy_byte=true send_stream_meta=true send_frame_meta=true cleanup=true
max_size=<maxDimension> max_fps=<fps> video_bit_rate=<bitrateKbps×1000>`. No option that changes a
   device setting (`show_touches`, `stay_awake`, `screen_off_timeout`, `power_off_on_close`); with
   `control=false` the server never powers the screen on.
4. No `adb forward`: a TCP connection to Simlock's adb server sends `host:transport:<serial>`, then
   `localabstract:scrcpy_<scid>`. `FAIL` on the second (nothing listening yet), a refused connect, or a
   socket that closes before the server's zero byte → retry every 100 ms. `FAIL` on the first → refuse.
5. Then the codec id (must be `h264`) and the first session packet (width, height) → `open` resolves.
   One 15 s budget from the push's return to here. Past it, or when the shell exits first →
   `ScreenUnavailableError` with the server's last 20 output lines.
6. Body: meta (session size, configured fps) on every session packet; the `avcC` description before
   the first picture after config packets; key/delta frames as 4-byte-length AVCC. Pull-based
   (`highWaterMark: 0`): the socket is read only when the body's reader pulls; nothing is dropped.
   A body whose socket ends errors with the server's last output and closes the feed. scrcpy sends
   nothing for a still screen, so after 5 s of quiet the body sends an empty `alive` frame.
7. `close` (idempotent, ≤ 5 s): close the socket, wait 1 s for the shell, then SIGKILL it,
   `adb shell rm -f <jar>`. The body's end, error or cancel calls it.

A rotation starts a new scrcpy session: a new meta frame, then a new description before the next
picture; the browser decoder re-reads both mid-stream.

Stop: `open` takes an `AbortSignal`. A stop before the push runs nothing; one during the push (it
cannot be interrupted) starts no server after it; one while connecting ends the retries. A stopped
open cleans up (shell killed, jar removed) before it throws. `alive` frames begin only after the
first key frame, so an encoder that never paints meets the stream's silence bound.

## State and timers

| What                 | Default                         | Key                                                         |
| -------------------- | ------------------------------- | ----------------------------------------------------------- |
| Push / start / close | 30 s / 15 s, retry 100 ms / 5 s | `PUSH_TIMEOUT_MS`, `START_DEADLINE_MS`, `CLOSE_DEADLINE_MS` |
| Quiet before `alive` | 5 s                             | `ALIVE_AFTER_MS`                                            |

Writes on the device: `/data/local/tmp/simlock-scrcpy-<scid>.jar`, removed by the server's clean-up
process at its start and by `rm -f` on close.

## Rules

- A screen stream touches only its own `scid`: its jar path and socket name; never another stream's.
- A screen stream changes no device setting and drops no frame.

## Known gaps

- **The slow-lane stream test has not passed yet.** `e2e/slow-android-stream.test.ts` failed at the
  lease on a nearly full disk. A live check on a Pixel 9 emulator streamed, and once the host
  `adb shell` died no scrcpy process and no jar were left on the device.
- **Key frames every 10 s** (scrcpy's default): a viewer that resets its decoder waits up to 10 s.
- **The `avcC` record omits the High-profile extension** (chroma format, bit depths); browsers accept it.
- **Physical Android devices have no screen stream**, and the jar's digest is not checked at push.

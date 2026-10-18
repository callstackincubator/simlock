# Android screen capture

Does: an Android emulator's or a leased physical phone's screen as core's screen frames, through the vendored scrcpy
server and our own client.
Entry: `index.ts` → `createAndroidScreenCapture(options)`, built by `AndroidDriver` as its `screenCapture` when `create`
gets `scrcpyServerPath` and `tcpStreamConnector` (`daemon/main.ts` passes the jar `pnpm build` copies to dist/vendor/scrcpy).
Uses: core (`ScreenCapture`, frame encoder), ports (`Clock`, `Filesystem`), the device's `ScreenTarget` (below).
Parent: [Android driver](../AGENTS.md). Consumer: [stream](../../../stream/AGENTS.md).

## Files

| File              | Role                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `index.ts`        | `createAndroidScreenCapture`: the driver's `ScreenCapture`, entered only here  |
| `session.ts`      | One stream: screen read, push, server, socket, body, close; the `ScreenTarget` |
| `adb-socket.ts`   | `openDeviceSocket`: `host:transport` + `localabstract` on the target's server  |
| `scrcpy-video.ts` | `ScrcpyVideoParser`: scrcpy's video socket (codec id, session, media packets)  |
| `h264.ts`         | Annex-B split, AVCC, the `avcC` record                                         |
| `envelope.ts`     | `EnvelopeMapper`: scrcpy events → core's screen frames                         |

## Where a session runs: the target

The driver hands the capture one `ScreenTarget` per device: `serial`, `run(args, timeoutMs)`, `spawn(args)` and
`connect(timeoutMs)`. `args` start at the adb subcommand — the target aims them at its device and picks its adb server.

- **Emulator** (`index.ts` of the driver): `adb -s <serial> …` with the driver's scoped env, connections to Simlock's
  own adb server.
- **Physical phone** (`../physical-handler.ts`): each of `run`, `spawn` and `connect` first passes the 5037 protocol
  check every other phone command passes; a closed check sends nothing and throws `ScreenUnavailableError` with its
  message. An open one runs `adb -P 5037 -s <deviceId> …` with that server's env (Simlock's port in it,
  `ANDROID_ADB_SERVER_ADDRESS`, `ADB_SERVER_SOCKET` and `ANDROID_SERIAL` removed), or connects to port 5037.

**This capture never names port 5037 and never runs that check** — the physical handler is the one place that knows
both (architecture rule 10, safety rule: the check before every physical command). A physical iPhone stays refused by
the iOS driver, not here.

## How it works

1. Jar missing at `scrcpyServerPath` → `ScreenUnavailableError` (`unavailable()` gives the same reason). Then the
   device's target. **A phone's screen state is read before anything is pushed**:
   `run(["shell", "dumpsys", "power"], 10_000)`, the line
   `^\s*mWakefulness=(\S+)\s*$` after a trailing `\r` is stripped — what follows the word, if anything,
   is blanks, so a printed `Dozing ` (a trailing blank) is the word `Dozing` — compared exactly. `Asleep` or
   `Dozing` → wake it: `run(["shell", "input", "keyevent", "KEYCODE_WAKEUP"], 10_000)` (its exit is not looked at; a
   closed check at the wake still refuses), then the same read again. A second read of `Asleep` or `Dozing` →
   `ScreenUnavailableError("The phone's screen is off and did not turn on. …")`, and nothing is pushed. Anything
   else — `Awake`, `Dreaming`, a word that is not one, no line, a non-zero exit, a timed-out read — goes on, with no
   wake after a first read of those. Emulators skip the read and the wake. The wake is the only key sent.
2. `scid`: random 31-bit, written `%08x`. `<target> push <jar> /data/local/tmp/simlock-scrcpy-<scid>.jar` (40 s: the
   phone's own check plus the 30 s push).
3. `<target> shell CLASSPATH=<that path> app_process / com.genymobile.scrcpy.Server 5.0.1 scid=<scid>
log_level=info tunnel_forward=true video=true audio=false control=false video_codec=h264
send_device_meta=false send_dummy_byte=true send_stream_meta=true send_frame_meta=true cleanup=true
[stay_awake=true for a phone] max_size=<maxDimension> max_fps=<fps> video_bit_rate=<bitrateKbps×1000>`. Only a
   phone's gets `stay_awake=true`: scrcpy sets `stay_on_while_plugged_in` to 7 and its clean-up process puts
   the old value back when the server ends. No other option changes a device setting (`show_touches`,
   `screen_off_timeout`, `power_off_on_close`); with `control=false` the server never powers the screen on, so the
   wake above is simlock's.
4. No `adb forward`: `target.connect` reaches the device socket and the session sends `host:transport:<serial>`, then
   `localabstract:scrcpy_<scid>`. `FAIL` on the second (nothing listening yet), a refused connect, or a
   socket that closes before the server's zero byte → retry every 100 ms. `FAIL` on the first → refuse.
5. Then the codec id (must be `h264`) and the first session packet (width, height) → `open` resolves.
   One 15 s budget from the moment `spawn`'s process started (a phone's check before it is outside the
   budget; each attempt's own check is inside it, and one still running past the deadline is waited for,
   ≤ 5 s) to here. Past it, or when the shell exits first → `ScreenUnavailableError` with the server's last
   20 output lines. Each step keeps its own limit; there is no overall budget. A phone's worst case is
   about 185 s (checks 45 s the first time and 5 s before each later step, three screen steps 20 s each, the push
   40 s, the server 15 s and a last check 5 s), which is why the console waits 200 s for a stream's headers.
6. Body: meta (session size, configured fps) on every session packet; the `avcC` description before
   the first picture after config packets; key/delta frames as 4-byte-length AVCC. Pull-based
   (`highWaterMark: 0`): the socket is read only when the body's reader pulls; nothing is dropped.
   A body whose socket ends errors with the server's last output and closes the feed. scrcpy sends
   nothing for a still screen, so after 5 s of quiet the body sends an empty `alive` frame.
7. `close` (idempotent, ≤ 5 s): close the socket, wait 1 s for the shell, then SIGKILL it,
   `<target> shell rm -f <jar>` — through the target, so a check still closed then sends nothing and `close`
   resolves. The body's end, error or cancel calls it.

A rotation starts a new scrcpy session: a new meta frame, then a new description before the next
picture; the browser decoder re-reads both mid-stream.

Stop: `open` takes an `AbortSignal`. A stop before the screen read runs nothing; one during the first read, the
wake, the second read or the push (none can be interrupted) waits for it and runs nothing after it; one while connecting ends the retries.
A stopped open cleans up (shell killed, jar removed) before it throws. `alive` frames begin only after the
first key frame, so an encoder that never paints meets the stream's silence bound.

## State and timers

| What                 | Default                         | Key                                                         |
| -------------------- | ------------------------------- | ----------------------------------------------------------- |
| Phone's screen read  | 10 s                            | `SCREEN_READ_TIMEOUT_MS`                                    |
| Phone's wake         | 10 s                            | `WAKE_TIMEOUT_MS`                                           |
| Push / start / close | 30 s / 15 s, retry 100 ms / 5 s | `PUSH_TIMEOUT_MS`, `START_DEADLINE_MS`, `CLOSE_DEADLINE_MS` |
| Quiet before `alive` | 5 s                             | `ALIVE_AFTER_MS`                                            |

Writes on the device: `/data/local/tmp/simlock-scrcpy-<scid>.jar`, removed by the server's clean-up
process at its start and by `rm -f` on close.

## Rules

- A screen stream touches only its own `scid`: its jar path and socket name; never another stream's.
- A screen stream changes no device setting and drops no frame. One exception: a phone's stream sets stay
  awake (`stay_on_while_plugged_in` to 7) while it runs, and scrcpy puts the old value back.
- Every adb command and connection of a session goes through its target. The capture names no adb server port and
  runs no version check of its own.

## Known gaps

- **The slow-lane stream test has not passed yet.** `e2e/slow-android-stream.test.ts` failed at the
  lease on a nearly full disk. A live check on a Pixel 9 emulator streamed, and once the host
  `adb shell` died no scrcpy process and no jar were left on the device.
- **Key frames every 10 s** (scrcpy's default): a viewer that resets its decoder waits up to 10 s.
- **The `avcC` record omits the High-profile extension** (chroma format, bit depths); browsers accept it.
- **A phone that is not charging is woken but not held awake**: stay awake does nothing without power. When its
  screen turns off mid-stream it shows its last picture, still marked live by `alive` frames, until the screen is on
  again or the lease ends. Nothing ends the stream for it.
- **A phone woken to its lock screen streams the lock screen.** simlock does not unlock it.
- **Two viewers of one lease**: the second's server finds the setting at 7 already and remembers nothing; when the
  first viewer's stream ends, the old value comes back while the second still streams.
- **The setting stays at 7** if the phone loses power or reboots before the clean-up process writes the old value back.
- **A holder's own stay-awake change is overwritten**: a holder that changes `stay_on_while_plugged_in` over
  passthrough `adb` while a stream is open has it replaced when the stream ends, since scrcpy writes back the value it found.
- **A pushed jar can survive on a phone** when the version check closes after the push and stays closed through the
  close and the server never started: the `rm -f` goes through that check and is not sent. A server that started
  deletes its own jar (`cleanup=true`). The jar's digest is not checked at push either.

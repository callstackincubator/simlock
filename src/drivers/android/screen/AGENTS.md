# Android screen capture

Does: an Android emulator's or a leased physical phone's screen as core's screen frames, through the vendored scrcpy server and our own client.
Flows: [Android driver](../AGENTS.md), [input](../input/AGENTS.md), [stream](../../../stream/AGENTS.md).

## Rules

The target:

- The driver hands the capture one `ScreenTarget` per device. Every adb command and connection of a session goes through it: `args` start at the adb subcommand, and the target aims them at its device and picks its adb server.
- The capture names no adb server port and runs no version check of its own. The physical handler (`../physical-handler.ts`) is the one place that knows both (architecture rule 10; safety rule: the check before every physical command). Each of a phone's `run`, `spawn` and `connect` passes the check first; a closed check sends nothing and throws `ScreenUnavailableError` with its message.
- A physical iPhone stays refused by the iOS driver, not here.
- A screen stream touches only its own `scid`: its jar path and socket name; never another stream's.

What a stream does to the device:

- A screen stream changes no device setting and drops no frame. One exception: a phone's stream sets stay awake (`stay_awake=true`, scrcpy's `stay_on_while_plugged_in`) while it runs, and scrcpy's clean-up process puts the old value back when the server ends. An emulator's server never gets the option.
- A phone's screen state is read before anything is pushed (`mWakefulness` in `dumpsys power`). `Asleep` or `Dozing`: one `KEYCODE_WAKEUP`, then the same read again; still off is `ScreenUnavailableError`, and nothing is pushed. The wake's exit is not looked at.
- Only a read that names one of those two words is a fact about the screen. Another word, no line, a non-zero exit or a timed-out read goes on, with no wake. The word can be printed with a trailing blank (`Dozing `).
- The wake is the only key this stream sends: with `control=false` the server never powers the screen on. Emulators skip the read and the wake.

Start and stop:

- No `adb forward`: the session speaks adb's host protocol through the target, so a daemon that dies leaves no listening port on the host.
- `FAIL` on the second request (nothing listening yet), a refused connect, or a socket that closes before the server's zero byte is retried. `FAIL` on the first refuses.
- The start budget (`START_DEADLINE_MS` in `scrcpy-link.ts`) counts from the moment the server's process started, so a phone's check before the spawn does not spend it. Each step keeps its own limit; there is no overall budget.
- A phone's worst case is the sum of those limits. The console's wait for a stream's headers (`STREAM_HEAD_TIMEOUT_MS` in `ui/src/state/screen.ts`) must stay above it.
- The screen read, the wake and the push cannot be interrupted: a stop during one waits for it and runs nothing after it. A stopped open cleans up (shell killed, jar removed) before it throws.
- `close` is idempotent. It removes the jar through the target, so a check still closed then sends nothing and `close` still resolves. The body's end, error or cancel calls it.

The body:

- It is pull-based (`highWaterMark: 0`): the socket is read only when the body's reader pulls, so nothing is dropped.
- scrcpy sends nothing for a still screen, so after `ALIVE_AFTER_MS` of quiet the body sends an empty `alive` frame. `alive` frames begin only after the first key frame, so an encoder that never paints meets the stream's silence bound.
- A rotation starts a new scrcpy session: a new meta frame, then a new description before the next picture. The browser decoder re-reads both mid-stream.
- A body whose socket ends errors with the server's last output and closes the feed.

## Known gaps

- **The slow-lane stream test has not passed yet.** `e2e/slow-android-stream.test.ts` failed at the
  lease on a nearly full disk. A live check on a Pixel 9 emulator streamed, and once the host
  `adb shell` died no scrcpy process and no jar were left on the device.
- **Key frames come at scrcpy's default interval**: a viewer that resets its decoder waits for the next one.
- **The `avcC` record omits the High-profile extension** (chroma format, bit depths); browsers accept it.
- **A phone that is not charging is woken but not held awake**: stay awake does nothing without power. When its
  screen turns off mid-stream it shows its last picture, still marked live by `alive` frames, until the screen is on
  again or the lease ends. Nothing ends the stream for it.
- **A phone woken to its lock screen streams the lock screen.** simlock does not unlock it.
- **Two viewers of one lease**: the second's server finds the stay-awake setting already on and remembers nothing; when the
  first viewer's stream ends, the old value comes back while the second still streams.
- **The stay-awake setting stays on** if the phone loses power or reboots before the clean-up process writes the old value back.
- **A holder's own stay-awake change is overwritten**: a holder that changes `stay_on_while_plugged_in` over
  passthrough `adb` while a stream is open has it replaced when the stream ends, since scrcpy writes back the value it found.
- **A pushed jar can survive on a phone** when the version check closes after the push and stays closed through the
  close and the server never started: the `rm -f` goes through that check and is not sent. A server that started
  deletes its own jar (`cleanup=true`). The jar's digest is not checked at push either.

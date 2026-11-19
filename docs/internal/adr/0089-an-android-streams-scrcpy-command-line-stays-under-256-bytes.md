# 0089. An Android stream's scrcpy command line stays under 256 bytes

- **Status:** Proposed
- **Date:** 2026-11-19

## Context

An Android stream starts the vendored scrcpy server with
`app_process / com.genymobile.scrcpy.Server <version> <options>`. At the
largest stream settings (4096 px, 60 fps, 40 Mbps) a phone's command line,
from `app_process` on with each argument's NUL, was 399 bytes.

On a Samsung Galaxy Tab A7 Lite (SM-T227U, Android 13, MediaTek) the server
printed its device line and then aborted with `stack corruption detected
(-fstack-protector)`, exit 134, before it sent the session packet. The crash
was in the media codec service's setup of the H.264 encoder
(`libsfplugin_ccodec.so`, `CCodec::customConfigVideoEncoder`), on both the
hardware and the software encoder. Measured on 2026-11-18 and 2026-11-19
with the same effective settings:

| Command line                                             | Result                       |
| -------------------------------------------------------- | ---------------------------- |
| 211, 237, 254, 256 and 257 bytes                         | streamed                     |
| 265 bytes and above                                      | aborted                      |
| 418 bytes: the 399-byte launch with `--nice-name=scrcpy` | aborted, three runs of three |

Upstream knows the limit, about 255 characters from `app_process` on, on
Samsung devices since 2021
([scrcpy #2841](https://github.com/Genymobile/scrcpy/issues/2841), open; a
Galaxy S9 streamed at 254 and aborted at 255, in Samsung's
`ACodec::reconfigEncoder4OtherApps`). It has no fix: a server config file
([#5153](https://github.com/Genymobile/scrcpy/pull/5153)) was closed
unmerged, and options sent over the first socket
([#6013](https://github.com/Genymobile/scrcpy/pull/6013)) are open,
unmerged. `--nice-name` does not help: app_process blanks the old command
line and writes the name into it, so `/proc/<pid>/cmdline` keeps its full
length.

Read in scrcpy v5.0.1's server (`Options.java`, `CodecOption.java`):

- Seven options Simlock passed equal its defaults: `video`, `control`,
  `video_codec=h264`, `send_dummy_byte`, `send_stream_meta`,
  `send_frame_meta` and `cleanup`.
- A boolean option is `Boolean.parseBoolean`: only `true` (any case) is
  true, so `0` is false.
- A codec option with no type is an `int`.
- With no `log_level` the server logs at debug. Its debug lines a screen
  stream reaches are written once, at start and stop (the encoder and
  display API in use, size alignment, each codec option set); none is
  written per frame or per reset.

Without the seven defaults the largest line is still 281 bytes; with `0`
for false and the untyped codec option, 261.

## Decision

1. The server's command line leaves out the options that only restate
   scrcpy's fixed defaults, and `log_level`. It writes false as `0` and the
   key frame interval as `i-frame-interval=2`. The stream settings (size,
   frame rate, bitrate) are always passed. A phone's line stays under 256
   bytes at the largest stream settings (246 today). A unit test pins the
   length; an option that does not fit needs another way in.
2. Two left-out defaults are relied on: `control=true` (the reset video of
   ADR 0079 §5 needs the control channel, and `power_on` and
   `clipboard_autosync` are passed only because of it) and `cleanup=true`
   (it puts a phone's stay-awake setting back and deletes the jar). A
   scrcpy upgrade checks both, beside the launch.
3. ADR 0079 §5 is unchanged: scrcpy's interval stays 2, and the 4 s reset
   still bounds a still screen.

## Consequences

- Android streams start on devices with the limit.
- The server logs at debug: a few more lines at start, in the output whose
  last lines a failure is reported with, and in the device's logcat.
- `0` reads less plainly than `false`; the launch says why beside it.
- About 10 bytes are left. A new server option has to fit them, or replace
  one.

## Alternatives considered

- **`--nice-name`.** Rejected on the measurement above.
- **Leave out the key frame interval and keep `log_level=info`.** 238
  bytes. Rejected: at scrcpy's own interval a moving screen sends no key
  frame of its own (ADR 0079's measurement), so the 4 s reset would restart
  the device's capture and encoder every 4 s for as long as the screen
  moves.
- **Also leave out `send_device_meta=false`.** Rejected: the video parser
  would have to read and skip scrcpy's 64-byte device-name header, a change
  to the stream's start for every device.
- **A launcher class of Simlock's own** on the classpath after scrcpy's
  jar, taking a short command line and calling
  `com.genymobile.scrcpy.Server.main` with the full options in the process.
  It removes the budget, but needs a dex build and a second jar to push and
  remove. Kept for when the budget runs out.
- **Patch scrcpy's defaults.** Rejected: the jar would no longer be
  byte-identical to upstream's signed release, and Simlock would build
  scrcpy.
- **A shorter interval only on devices that allow it.** Rejected: no
  device property says where the limit is, and a failed start costs the
  whole stream.

# 0089. An Android stream's scrcpy command line stays under 256 bytes

- **Status:** Proposed
- **Date:** 2026-11-19
- **Narrows:** [ADR 0079](0079-one-capture-per-device-is-shared-by-every-viewer-and-every-capture-sends-a-key-frame-every-5-s.md)
  §5 ("scrcpy's own interval is set to 2, so a moving screen rarely needs
  a reset"). Its 5 s key frame promise and the 4 s reset stay.

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

| Command line                                   | Result                    |
| ---------------------------------------------- | ------------------------- |
| 211, 237, 254, 256 and 257 bytes               | streamed                  |
| 265 bytes and above                            | aborted                   |
| 418 bytes: the 399-byte launch with `--nice-name=scrcpy` | aborted, three runs of three |

scrcpy's maintainer reports the same limit, about 255 characters, on other
Samsung devices ([scrcpy #6781](https://github.com/Genymobile/scrcpy/issues/6781)).
`--nice-name` does not help: app_process blanks the old command line and
writes the name into it, so `/proc/<pid>/cmdline` keeps its full length.

Seven options Simlock passed equal scrcpy's own defaults: `video`,
`control`, `video_codec=h264`, `send_dummy_byte`, `send_stream_meta`,
`send_frame_meta` and `cleanup`. Without them the largest line is still
about 281 bytes. Only dropping `video_codec_options=i-frame-interval:int=2`
as well brings it under 256 (238 bytes).

## Decision

1. The server's command line leaves out the options that only restate
   scrcpy's fixed defaults; the stream settings (size, frame rate, bitrate)
   are always passed. A phone's line stays under 256 bytes at the largest
   stream settings. A unit test pins the length; an option that does not
   fit needs another way in.
2. No encoder key frame interval is set, so scrcpy asks the encoder for its
   own default (10 s in v5.0.1). ADR 0079 §5's 4 s reset becomes the main
   path to a key frame on a moving screen as well as a still one, and its
   5 s bound (and §4's joiner wait) holds when the reset is answered within
   the remaining 1 s. A device that answers later goes past it; see below.

## Consequences

- Android streams start on devices with the limit.
- A moving screen gets the encoder's default interval instead of 2, so the
  4 s reset fires during motion more often. Each reset starts a new scrcpy
  session: a new meta frame and parameter sets before the next picture, as
  for a rotation.
- The Android screen module's known gap, a fresh emulator that answers its
  first resets slowly
  ([manual](../../../src/drivers/android/screen/AGENTS.md#known-gaps)), now
  reaches a moving screen too. Before, the encoder's own key frames usually
  came first; now they rarely do. On such an emulator a moving screen can
  go past ADR 0079 §5's bound, and a joiner past §4's wait, as a still
  screen already could.
- A new server option has to fit the budget, or replace one.

## Alternatives considered

- **`--nice-name`.** Rejected on the measurement above.
- **Keep the interval and also drop `log_level=info` and
  `send_device_meta=false`.** 243 bytes at the largest settings, 13 under
  the budget. Rejected for now: the server would log at its debug default,
  and the video parser would have to read and skip scrcpy's 64-byte
  device-name header, a change to the stream's start for every device.
- **A shorter interval only on devices that allow it.** Rejected: no
  device property says where the limit is, and a failed start costs the
  whole stream.

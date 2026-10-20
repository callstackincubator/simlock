# vendor

| Directory         | Upstream                                                                                                                                                                | License                                                                     | Notice                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `screen-capture/` | `EvanBacon/serve-sim` — a capture and encode pipeline we patched, four files rewritten; plus one HEVC capability string from `jkcoxson/idevice` (MIT)                   | Apache-2.0 (our own files MIT, one MIT string from idevice)                 | [`screen-capture/NOTICE.md`](screen-capture/NOTICE.md) |
| `scrcpy/`         | `Genymobile/scrcpy` — the server artifact, byte-identical, pushed unmodified to a leased emulator by the Android driver, whose client is ours in `src/drivers/android/` | Apache-2.0, plus BSD-3-Clause and BSL-1.0 code in the bundled Kotlin stdlib | [`scrcpy/NOTICE.md`](scrcpy/NOTICE.md)                 |

A first-level directory here is third-party or derived-from-third-party code, and
it holds the artifact(s), the license text(s) they require in `LICENSES/`, and a
`NOTICE.md`: upstream and author, the exact commit or release, what was taken and
what was left out, every deviation and why, the command that re-verifies it all
against upstream, and — per file, because a directory here can hold our code
beside theirs — which files are ours. `src/source-hygiene.test.ts` enforces
the three-part shape, and the rules are
[`docs/internal/agent-rules/vendor-and-third-party-code.md`](../docs/internal/agent-rules/vendor-and-third-party-code.md);
the whole inventory is [`docs/internal/VENDORED-CODE.md`](../docs/internal/VENDORED-CODE.md).

Nothing here is downloaded at install, at build or at run time — it is in the
tree because somebody fetched and checked it once.

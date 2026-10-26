# Vendored code

Every piece of third-party code this repository carries, and how to re-verify
each one. The rules that decide what goes in this list are in
[agent-rules/vendor-and-third-party-code.md](agent-rules/vendor-and-third-party-code.md);
this page is the inventory, one row per dependency. A change under `vendor/`
updates the affected row here, its directory's `NOTICE.md`, and
[`vendor/README.md`](../../vendor/README.md)'s index, in the same change.

The convention, in one line: `vendor/<upstream>/` holds the artifact(s), the
license text(s) they require under `LICENSES/`, and a `NOTICE.md`.

## The inventory

| What | Upstream | Version / commit | License | Where it lives | Consumed by | Re-verify with |
|---|---|---|---|---|---|---|
| serve-sim's capture and encode pipeline — CoreSimulator framebuffer capture and the H.264 encode path, patched by us, with four files rewritten by us that stay serve-sim's modified files | `EvanBacon/serve-sim` | commit `6d009686ed08f7d8bd19bca9f9f67a9237931f44` | Apache-2.0 for serve-sim's files and our rewrites of four of them; MIT for the files that are ours entirely | `vendor/screen-capture/Sources/`, licenses at `vendor/screen-capture/LICENSES/serve-sim.APACHE-2.0.txt` and `…/idevice.MIT.txt` | the `simlock-screen-capture` and `simlock-device-capture` programs `pnpm build` puts in dist/bin, run by `src/drivers/ios/screen-capture.ts` | the `curl … \| diff -u -` command in [`vendor/screen-capture/NOTICE.md`](../../vendor/screen-capture/NOTICE.md), per file |
| the HEVC capability string the iPhone's media-stream offer advertises for payload 100 — one string inside one of our own files | `jkcoxson/idevice` | `master` at the time of taking; the string is what its receiver documents | MIT | `vendor/screen-capture/LICENSES/idevice.MIT.txt`, the string in `vendor/screen-capture/Sources/SimlockMediaBridge/SimlockMediaBridge.m` | `simlock-device-capture`, whose offer a physical iPhone accepts without painting torn pictures | the string in `Sources/SimlockMediaBridge/SimlockMediaBridge.m` against idevice's receiver, and its `LICENSE.txt` at `https://raw.githubusercontent.com/jkcoxson/idevice/master/LICENSE.txt` |
| `scrcpy-server` — the Android screen-streaming server artifact, byte-identical to upstream's release asset | `Genymobile/scrcpy` | release `v5.0.1`; revision built `dc8a55a24c27ae78ae202b5a3288da681d0f141a` | Apache-2.0; the Kotlin standard library inside it adds BSD-3-Clause (ThreeTen-BP) and BSL-1.0 (Boost) code | `vendor/scrcpy/scrcpy-server-v5.0.1`, licenses at `vendor/scrcpy/LICENSES/scrcpy.APACHE-2.0.txt` and `vendor/scrcpy/LICENSES/threetenbp.BSD-3-Clause.txt`, digest in `vendor/scrcpy/SHA256SUMS.txt` | the Android driver's screen capture, which pushes it unmodified to a leased emulator; the client that drives it is ours, in `src/drivers/android/`, and is not vendored | `cd vendor/scrcpy && shasum -a 256 -c SHA256SUMS.txt`, and the same against upstream's own release `SHA256SUMS.txt`, whose GPG signature `vendor/scrcpy/NOTICE.md` says how to check |

`vendor/scrcpy/NOTICE.md` names what is *inside* that artifact besides scrcpy's
own classes — the Kotlin standard library 2.2.10 and the JetBrains/IntelliJ
annotation classes — because they are in the file we distribute even though we
did not choose them one by one. Not all of it is Apache-2.0: Kotlin's own
`license/README.md` marks `kotlin.time` as derived from ThreeTen-BP (BSD-3-Clause,
whose notice binary redistribution must carry, so its text is in
`vendor/scrcpy/LICENSES/`) and `MathJVM.kt` as derived from Boost (BSL-1.0, which
exempts object code). Upstream scrcpy ships the artifact without the ThreeTen-BP
text.

## What is third-party but not vendored

These are third-party code the repo depends on and ships or installs through
their own distribution, so `vendor/` is the wrong place for them and this is the
reason they are not above.

| What | Upstream | Version | License | Where it is | Why it is not vendored |
|---|---|---|---|---|---|
| React, React DOM, Hono, `ws`, Zod, the MCP SDK, TanStack table/virtual, Recharts | npm | as `pnpm-lock.yaml` pins | per package | `node_modules/`, resolved from the lockfile | A registry gives us these, with their licenses; vendoring a tree we never patch only loses upstream's fixes |
| The Geist and Geist Mono variable fonts | `vercel/geist-font`, repackaged as `@fontsource-variable/geist` | `^5.3.0` | OFL-1.1 | `ui/src/main.tsx` imports them; the built console serves the `.woff2` files out of `dist/ui/assets/` | Installed from npm and bundled at build time. **Known gap:** the font license travels with the npm package but Vite does not copy it beside the emitted `.woff2`, and OFL-1.1 wants the license to accompany the font; the fix is to ship the license with the console build, not to vendor the fonts |
| `@agent-device/proxy` — the transport proxy in front of an agent-device daemon | npm (`callstack/agent-device`) | as `package.json` pins | MIT (Callstack) | `node_modules/@agent-device/proxy/`, resolved from the lockfile; `src/agent-device/host/` imports it | A registry gives us the released proxy with its license; nothing of it is a file in this repo |
| The agent-device CLI itself | `callstack/agent-device` | the version `package.json` pins for `@agent-device/proxy` | MIT | a separate install, at the absolute path `SIMLOCK_E2E_AGENT_DEVICE` gives, on machines that run the slow lane | It is a tool we invoke, not code we carry; `toolchain.md` says how to read its source at that version |

The license question for the npm rows is answered by npm, which ships each
package's own license text next to it; nothing in those rows is a file in this
repo, which is what separates them from the inventory above.

## External tools are not vendored

`simctl` and the rest of Xcode's command-line tools, the Android SDK's
`emulator`, `avdmanager` and `sdkmanager`, and `adb` are **prerequisites this
project invokes and does not carry**. They arrive with the user's Xcode or Android
SDK installation, at whatever version that installation happens to be, and
simlock never downloads, bundles, or pins one. The website's requirements page and the
driver prerequisite checks are where their absence is reported.

Worth keeping the two ideas apart, because the confusion is cheap to make: a
vendored artifact is a byte we distribute and are therefore obliged to license
correctly, while an external tool is something we shell out to and can only ask
for. That is why the scrcpy *server* is vendored and `adb` — which is how it
reaches the device — is not; and why the capture program's Swift source is
vendored while the Xcode that compiles it is not.

## How a new vendored thing gets here

1. Decide it cannot stay an upstream dependency: a registry does not carry the
   line we need, or we must patch it.
2. Make `vendor/<upstream>/`, put the artifact(s) in it, upstream's verbatim
   license text in `LICENSES/<upstream>.<SPDX-id>.txt`, and `NOTICE.md` written
   to the list in rule 4 of
   [agent-rules/vendor-and-third-party-code.md](agent-rules/vendor-and-third-party-code.md).
   A binary also gets `SHA256SUMS.txt` in `shasum -c` format.
3. Add the row here and the directory to `vendor/README.md`'s index.
4. `pnpm exec vitest run --project unit src/source-hygiene.test.ts` checks the
   shape (license text, `NOTICE.md`, the digest, and that a vendored binary is
   excluded from the text scan for a reason it can prove).

Nothing here is fetched at install, at build or at run time: an artifact is in
the tree because a person or an agent fetched it once, checked it, and committed
it, which is what safety rule 4's consent requirement looks like for vendored
code.

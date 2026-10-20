# Vendored: scrcpy server

**Consumed by the Android driver's screen capture**, which pushes this artifact
unmodified to a leased emulator and talks to the server it starts there. The
client on our side of that conversation is ours, not vendored: it lives in
`src/drivers/android/`, and nothing of ours is in this directory but the
paperwork listed under "What is ours".

## Upstream

|                |                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository     | <https://github.com/Genymobile/scrcpy>                                                                                                                                                                                                                            |
| Author         | Romain Vimont / Genymobile                                                                                                                                                                                                                                        |
| Release        | `v5.0.1`                                                                                                                                                                                                                                                          |
| Release asset  | `scrcpy-server-v5.0.1` (733,930 bytes)                                                                                                                                                                                                                            |
| Revision built | `dc8a55a24c27ae78ae202b5a3288da681d0f141a` — from `META-INF/version-control-info.textproto` inside the artifact                                                                                                                                                   |
| License        | Apache-2.0, verbatim: [`LICENSES/scrcpy.APACHE-2.0.txt`](LICENSES/scrcpy.APACHE-2.0.txt); the artifact also carries BSD-3-Clause code, verbatim: [`LICENSES/threetenbp.BSD-3-Clause.txt`](LICENSES/threetenbp.BSD-3-Clause.txt) — see "What is inside the binary" |

Upstream's own warning, from the top of its README, applies to this file:

> This GitHub repo (<https://github.com/Genymobile/scrcpy>) is the only official
> source for the project. Do not download releases from random websites, even if
> their name contains `scrcpy`.

## What we vendored, and what we left out

One file: the release asset `scrcpy-server-v5.0.1`. It is byte-identical to the
asset upstream published — see `SHA256SUMS.txt`, and run
`shasum -a 256 -c SHA256SUMS.txt` from this directory to check.

We vendored no client, no build files, no documentation, no submodules. scrcpy's
client links FFmpeg and SDL; the client is not in this artifact and we do not use
it, so neither library is here. Upstream ships one root `LICENSE` and no `NOTICE`
file, so Apache §4(d) has nothing to carry, and we ship that `LICENSE` verbatim
beside the binary as §4(a) requires of a distribution.

### What is inside the binary

Despite the name and the `.jar` habit of other projects, the artifact is **not a
jar**: it is an unsigned APK (a ZIP) with 13 members, of which `classes.dex`
(2,302,128 bytes) is the whole program. Inspecting it — the commands are below —
shows whose code is in there besides scrcpy's own:

| Inside `classes.dex`                          | What                                                                                                                                                                                                                                                                                                                     | License                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lcom/genymobile/scrcpy/…`                    | 164 references, 149 distinct classes — scrcpy's own server                                                                                                                                                                                                                                                               | Apache-2.0 (upstream's)                                                                                                                                                                                                                                                         |
| `Lkotlin/…`                                   | the Kotlin standard library **2.2.10** — `KotlinVersionCurrentValue.get()` builds `KotlinVersion(2, 2, 10)` — 1,106 distinct classes, plus the `kotlin/*.kotlin_builtins` metadata files in the ZIP. Copyright 2010-2024 JetBrains s.r.o and respective authors and developers, as Kotlin's `license/NOTICE.txt` puts it | Apache-2.0, except the `kotlin.time` and `MathJVM.kt` rows below                                                                                                                                                                                                                |
| `Lkotlin/time/…` (58 distinct classes)        | compiled from `libraries/stdlib/src/kotlin/time`, which Kotlin's own [`license/README.md`](https://github.com/JetBrains/kotlin/blob/v2.2.10/license/README.md) marks as derived from **ThreeTen-BP**, Copyright (c) 2007-present, Stephen Colebourne & Michael Nascimento Santos                                         | **BSD-3-Clause**. Its second condition requires the notice in binary redistributions too, so the text is here, verbatim from Kotlin's `license/third_party/threetenbp_license.txt` at `v2.2.10`: [`LICENSES/threetenbp.BSD-3-Clause.txt`](LICENSES/threetenbp.BSD-3-Clause.txt) |
| `Lkotlin/math/MathKt__MathJVMKt`              | compiled from `libraries/stdlib/jvm/src/kotlin/util/MathJVM.kt`, which the same README marks as derived from **Boost** special math functions, Copyright Eric Ford & Hubert Holin 2001                                                                                                                                   | **BSL-1.0**. Its notice requirement exempts copies "solely in the form of machine-executable object code generated by a source language processor", which a dex is, so no text is required and none is shipped                                                                  |
| `Lkotlin/collections/…`, `Lkotlin/UnsignedKt` | parts the same README marks as derived from GWT, (C) 2007-08 Google Inc., and from Guava's `UnsignedLongs`, (C) 2011 The Guava Authors                                                                                                                                                                                   | Apache-2.0                                                                                                                                                                                                                                                                      |
| `Lorg/jetbrains/annotations/…`                | `NotNull`, `Nullable`, `Contract`, `Nls`, `NonNls`, `PropertyKey`, `TestOnly`                                                                                                                                                                                                                                            | Apache-2.0                                                                                                                                                                                                                                                                      |
| `Lorg/intellij/lang/annotations/…`            | `Flow`, `Identifier`, `Language`, `MagicConstant`, `Pattern`, `PrintFormat`, `RegExp`, `Subst`, `JdkConstants$…`                                                                                                                                                                                                         | Apache-2.0                                                                                                                                                                                                                                                                      |

We checked for the libraries that would have been a problem and found none of
them: **no** `androidx/`, **no** `kotlinx/`, **no** `com/google/` class
references occur in the dex. Nothing bundled conflicts with Apache-2.0 or with
simlock's MIT: Apache-2.0 everywhere except one BSD-3-Clause package and one
BSL-1.0 file, both permissive. One copy of the Apache-2.0 text covers every
Apache-2.0 row, since the terms are the same license. They are named here because
they are literally inside the file we distribute.

Upstream scrcpy has the same gap: its release ships this artifact with its own
Apache-2.0 `LICENSE` only, and no ThreeTen-BP text.

The server's own code is compiled against the Android framework and reaches
hidden framework members by reflection; that is upstream's design and needs no
header of ours.

## Deviations

**None.** We never patch, re-pack, re-sign, strip or rename this artifact, so
Apache §4(b) (stating changes) never engages. Renaming it would be a deviation:
the filename _is_ the version, and `SHA256SUMS.txt` names it.

## Why the version can never drift

The server refuses to start unless the version string it is handed as its first
argument equals its own `BuildConfig.VERSION_NAME` by exact string equality:

```java
// server/src/main/java/com/genymobile/scrcpy/Options.java, at v5.0.1
String clientVersion = args[0];
if (!clientVersion.equals(BuildConfig.VERSION_NAME)) {
    throw new IllegalArgumentException(
            "The server version (" + BuildConfig.VERSION_NAME + ") does not match the client (" + clientVersion + ")");
}
```

Upstream documents the reason in the same breath as the protocol:

> The protocol between the client and the server may change from version to
> version … and there is no backward or forward compatibility.

and, of the wire format itself:

> [It] may (and will) change at any time for any reason. Everything may change
> … from version to version. A client must always be run with a matching server
> version.

So three things are one value and must move together or not at all: the
filename, the version string the Android driver passes as the first argument,
and this notice. Bumping the artifact means re-downloading it, re-checking its
checksum against upstream's signed `SHA256SUMS.txt`, re-reading which Kotlin
version it carries and that version's `license/README.md`, changing the
filename, and changing this file, in one change.

## Re-verifying provenance

Checksum, from this directory — the same command the CI check runs:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Against upstream's own published checksums for the release:

```sh
curl -sL https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/SHA256SUMS.txt \
  | grep ' scrcpy-server-v5.0.1$' | shasum -a 256 -c -
```

Both print `scrcpy-server-v5.0.1: OK`. The expected digest is
`764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`, which is
what upstream's `SHA256SUMS.txt` for `v5.0.1` gives for this asset.

Upstream signs that checksum file: the release also publishes
`SHA256SUMS.txt.asc`, made with Romain Vimont's GPG key, as upstream's
`doc/verify-release.md` describes. To check the signature before trusting the
digest above — in a throwaway keyring, so nothing lands in yours:

```sh
export GNUPGHOME="$(mktemp -d)"; cd "$GNUPGHOME"
curl -sLO https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/SHA256SUMS.txt
curl -sLO https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/SHA256SUMS.txt.asc
curl -s https://blog.rom1v.com/keys/rom1v.asc | gpg --import
gpg --fingerprint 456958E85A185DD5C2D1E4E80C822B298461FA03
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
```

The fingerprint must read `4569 58E8 5A18 5DD5 C2D1  E4E8 0C82 2B29 8461 FA03`,
the one upstream's `doc/verify-release.md` publishes, and `gpg --verify` must print
`Good signature from "Romain Vimont <rom@rom1v.com>"`, made with the signing subkey
`E39E2DE6A55F5AA6D8EFB79ACA01F46F18683B3D`. It did on 2026-10-15 (the signature is
dated 2026-10-08); gpg also warns that the key is not certified, which only says you
have not signed it yourself.

The contents of the artifact, for the table above:

```sh
unzip -l scrcpy-server-v5.0.1
mkdir -p /tmp/scrcpy && unzip -o -q scrcpy-server-v5.0.1 -d /tmp/scrcpy
grep -aoE 'Lcom/genymobile/scrcpy/[A-Za-z0-9_/$]+;' /tmp/scrcpy/classes.dex | sort -u | wc -l
grep -aoE 'L(androidx|kotlinx)/|Lcom/google/'       /tmp/scrcpy/classes.dex | sort -u   # expect no output
grep -aoE 'Lkotlin/time/[A-Za-z0-9_/$]+;'         /tmp/scrcpy/classes.dex | sort -u | wc -l   # 58
grep -aoE 'Lkotlin/math/MathKt__MathJVMKt;'       /tmp/scrcpy/classes.dex | sort -u           # present
cat /tmp/scrcpy/META-INF/version-control-info.textproto
```

The Kotlin version, which decides which `license/README.md` applies — `dexdump`
ships in the Android SDK's `build-tools/<version>/`:

```sh
dexdump -d /tmp/scrcpy/classes.dex | grep -A5 'KotlinVersionCurrentValue.get:()'
# const/4 v1, #int 2 ; const/16 v2, #int 10 ; <init> {v0, v1, v1, v2} → KotlinVersion(2, 2, 10)
curl -sL https://raw.githubusercontent.com/JetBrains/kotlin/v2.2.10/license/README.md \
  | grep -B1 -A2 -E 'stdlib/(src/kotlin/time|jvm/src/kotlin/util/MathJVM.kt)$'
```

Upstream's license texts, to compare with the copies in `LICENSES/`:

```sh
curl -sL https://raw.githubusercontent.com/Genymobile/scrcpy/v5.0.1/LICENSE \
  | diff -u - LICENSES/scrcpy.APACHE-2.0.txt
curl -sL https://raw.githubusercontent.com/JetBrains/kotlin/v2.2.10/license/third_party/threetenbp_license.txt \
  | diff -u - LICENSES/threetenbp.BSD-3-Clause.txt
```

## What is ours

Nothing inside the artifact. Ours in this directory are `NOTICE.md`,
`SHA256SUMS.txt`, and the file names under `LICENSES/`; the license texts and the
binary are upstream's bytes unchanged. The code that pushes and drives the server
is ours too, and is not here: it is in `src/drivers/android/`, and never moves
under `vendor/`.

The precedent this layout follows is NetrisTV/ws-scrcpy (MIT), which vendors the
same upstream as `vendor/Genymobile/scrcpy/{scrcpy-server.jar,LICENSE}` — the
binary beside the license text in the same directory.

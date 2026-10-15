# Vendored: scrcpy server

**Not used by any code yet.** Nothing in this repository reads or pushes this
artifact. It is vendored as the pinned dependency the planned Android screen
streaming proof of concept will consume, so that the PoC starts from an
artifact whose bytes, license and version were settled before it was written.

## Upstream

| | |
|---|---|
| Repository | <https://github.com/Genymobile/scrcpy> |
| Author | Romain Vimont / Genymobile |
| Release | `v5.0.1` |
| Release asset | `scrcpy-server-v5.0.1` (733,930 bytes) |
| Revision built | `dc8a55a24c27ae78ae202b5a3288da681d0f141a` — from `META-INF/version-control-info.textproto` inside the artifact |
| License | Apache-2.0, verbatim: [`LICENSES/scrcpy.APACHE-2.0.txt`](LICENSES/scrcpy.APACHE-2.0.txt) |

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

| Inside `classes.dex` | What | License |
|---|---|---|
| `Lcom/genymobile/scrcpy/…` | 164 references, 149 distinct classes — scrcpy's own server | Apache-2.0 (upstream's) |
| `Lkotlin/jvm/…`, `Lkotlin/collections/…`, `Lkotlin/…` | 1,106 distinct Kotlin standard library classes, plus the `kotlin/*.kotlin_builtins` metadata files in the ZIP | Apache-2.0 |
| `Lorg/jetbrains/annotations/…` | `NotNull`, `Nullable`, `Contract`, `Nls`, `NonNls`, `PropertyKey`, `TestOnly` | Apache-2.0 |
| `Lorg/intellij/lang/annotations/…` | `Flow`, `Identifier`, `Language`, `MagicConstant`, `Pattern`, `PrintFormat`, `RegExp`, `Subst`, `JdkConstants$…` | Apache-2.0 |

We checked for the libraries that would have been a problem and found none of
them: **no** `androidx/`, **no** `kotlinx/`, **no** `com/google/` class
references occur in the dex. Every bundled component is Apache-2.0 like the
server itself, so nothing conflicts; they are named here because they are
literally inside the file we distribute.

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
filename, the version string a future caller passes as the first argument, and
this notice. Bumping the artifact means re-downloading it, re-checking its
checksum against upstream's `SHA256SUMS.txt`, changing the filename, and
changing this file, in one change.

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

The contents of the artifact, for the table above:

```sh
unzip -l scrcpy-server-v5.0.1
mkdir -p /tmp/scrcpy && unzip -o -q scrcpy-server-v5.0.1 -d /tmp/scrcpy
grep -aoE 'Lcom/genymobile/scrcpy/[A-Za-z0-9_/$]+;' /tmp/scrcpy/classes.dex | sort -u | wc -l
grep -aoE 'L(androidx|kotlinx)/|Lcom/google/'       /tmp/scrcpy/classes.dex | sort -u   # expect no output
cat /tmp/scrcpy/META-INF/version-control-info.textproto
```

Upstream's license text, to compare with the copy in `LICENSES/`:

```sh
curl -sL https://raw.githubusercontent.com/Genymobile/scrcpy/v5.0.1/LICENSE \
  | diff -u - LICENSES/scrcpy.APACHE-2.0.txt
```

## What is ours

Nothing inside the artifact. Ours in this directory are `NOTICE.md`,
`SHA256SUMS.txt`, and `LICENSES/`'s file name; the license text and the binary
are upstream's bytes unchanged.

The precedent this layout follows is NetrisTV/ws-scrcpy (MIT), which vendors the
same upstream as `vendor/Genymobile/scrcpy/{scrcpy-server.jar,LICENSE}` — the
binary beside the license text in the same directory.

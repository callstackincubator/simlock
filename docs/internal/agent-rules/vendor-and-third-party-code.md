# Agent rules: vendored and third-party code

Rules for anything third-party this repository carries in its own tree:
someone else's source, someone else's binary, someone else's package. The
inventory of what is here today is [../VENDORED-CODE.md](../VENDORED-CODE.md);
this file is the rule that keeps the inventory true.

1. **Third-party code lives under `vendor/`, one directory per upstream.**
   `src/`, `ui/`, `scripts/` and `e2e/` hold no file this project did not
   write. A dependency npm resolves stays an npm dependency — vendoring is for
   what a registry does not give us: a fork at an unreleased commit, a source
   tree we patch, an artifact we ship.

2. **A first-level directory under `vendor/` is third-party _or derived-from_
   third-party code, and never either by accident.** It holds the artifact(s) we
   took or derived, every license text they require, and a `NOTICE.md`. A
   directory here may also hold a build of that code — a tool compiled from
   vendored sources, with our CLI and envelope around it — because keeping a
   derivative beside what it derives from is what keeps the provenance in `rule
   5`'s diff readable; `vendor/screen-capture/` is that case. What a directory
   under `vendor/` must never hold is code with no upstream at all: that belongs
   in `src/`, `ui/`, `scripts/` or `e2e/`. `NOTICE.md`'s per-file origin table
   is what separates ours from theirs, and rule 6 makes that table mandatory
   precisely because the directory itself no longer does. The check
   `src/source-hygiene.test.ts` runs is the licensing half of this claim, so a
   directory that fails it misrepresents itself. A file sitting at `vendor/`'s
   root is a packed archive, not a directory, and carries its license inside it
   (the tarball rule 1's npm case does not cover) — that is why the check is per
   directory.

3. **A license text is upstream's verbatim text, named for what it covers.**
   It lives in `<dir>/LICENSES/<upstream>.<SPDX-id>.txt`. Do not name it
   `LICENSE`: a bare `LICENSE` in a directory states that it licenses
   everything there, and a vendored directory often holds our own files
   beside theirs. Where upstream ships no `NOTICE` file, say so in `NOTICE.md`
   — that is the difference between Apache §4(d) being satisfied and being
   vacuous, and a reader cannot tell from the archive.

4. **`NOTICE.md` states these, in this order.** Upstream repository and
   author; the exact commit or release every line came from; what we vendored
   and, as its own list, what we deliberately left out; every deviation we made
   from upstream, each with the reason that forced it; the one command that
   re-verifies provenance against upstream; and what in the directory is ours.
   Each of those is a checkable item, so the file is either complete or it is
   not. The reason a deviation needs its reason written down is that the only
   thing worse than an unexplained patch is a patch someone "cleans up" back to
   upstream's behaviour, breaking the feature that needed it.

5. **Vendored source records the commit and the diff command; it never stores
   a pristine copy.** `NOTICE.md` names the commit and prints the command that
   fetches upstream's version of a file and diffs it against ours. Committing
   pristine copies too gives a source file two homes, and sooner or later
   somebody edits the wrong one. The diff against upstream is also the
   early-warning system for a vendored file that reached an API the upstream
   platform moved — a major toolchain update shows up there before it shows up
   as a failure in the field.

6. **Vendored source names its origin per file, never by a count.** `NOTICE.md`
   carries a table of file → origin, and the line counts stay out of it: they
   are the first thing a rewrite invalidates, and a stale count reads as
   authority. Origin is not remembered, it is measured — `NOTICE.md` gives the
   command, and the row is wrong the moment the command says it is. Where a
   file is ours in shape and upstream's in idea, that is what the row says.

7. **A vendored binary is byte-identical to what upstream published, with its
   checksum beside it.** `SHA256SUMS.txt`, in upstream's own
   `<sha256>  <filename>` form, so `shasum -a 256 -c SHA256SUMS.txt` verifies
   the directory from inside it; the CI check runs that verification, so the
   claim is proved rather than asserted. Never patch, re-pack, re-sign or
   strip a vendored binary — an artifact we cannot reproduce byte for byte from
   the release is an artifact nobody can re-verify. When upstream publishes a
   checksum file for the release, check ours against it and say in `NOTICE.md`
   that we did.

8. **A vendored binary names what is inside it.** A packaged artifact carries
   other people's code we did not choose file by file — a runtime library,
   annotation jars, a bundled dependency. Name every one of those in
   `NOTICE.md` with its license, whether or not it conflicts with ours: it is
   in the artifact we distribute, so attribution reaches it, and the next
   reader cannot see it without unpacking the file.

   Whatever the package ships from `vendor/<dir>/` — the artifact itself or a
   program built from it — ships with that directory's `NOTICE.md` and
   `LICENSES/`, copied into `dist/vendor/<dir>/` by `scripts/build-capture.mjs`
   (tested in `src/build-capture.test.ts`). The package publishes `dist/`, and a
   license kept only in the repository never reaches whoever installs it.

9. **Nothing arrives over the network without the consent
   [safety.md](safety.md) rule 4 requires.** Vendoring is a commit: a person or
   an agent fetched the artifact once, checked it, and put it in the tree.
   Nothing in `vendor/` is downloaded at install, at build, or when the daemon
   starts, and no postinstall step reaches a package registry or a release URL
   for it. That rule is about multi-GB downloads the user never asked for; the
   same reason covers a 700 KB jar — a fetch nobody consented to is a failure
   nobody can attribute, and it makes a build's output depend on the state of
   someone else's server. Pinning a version and fetching it lazily is not a
   smaller version of this rule: it is the thing the rule forbids.

10. **A vendored artifact nothing consumes yet says so in its own notice.** A
    notice that reads as though the artifact were in use is a claim about the
    code, and it is false. Name the planned consumer and that it does not
    exist yet; the alternative — leaving the artifact unexplained — reads as
    somebody else's mistake and invites its deletion.

11. **A change under `vendor/` updates the notice and the inventory in the same
    change** (architecture rule 13, always-in-scope item 12): `NOTICE.md`, the
    row in [../VENDORED-CODE.md](../VENDORED-CODE.md), and `vendor/README.md`'s
    index. A toolchain upgrade of a vendored artifact is a new commit or
    release in those three places, not an edit of the old one: what the
    previous line was is the information a later diff needs.

12. **An external tool is not vendored, and is not listed as if it were.**
    Xcode's `simctl`, the Android SDK, `adb` and an emulator image are
    prerequisites we invoke and do not carry. They belong in the note that
    separates the two, not in the inventory's rows; conflating them is how a
    "we vendor it" claim ends up in a doc that a user then cannot install from.

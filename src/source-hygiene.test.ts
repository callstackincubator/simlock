import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const NUL = 0x00;

const lsFiles = (args: string[]): string[] =>
  execFileSync("git", ["ls-files", "-z", ...args], {
    cwd: REPO_ROOT,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((name) => name.length > 0);

/**
 * why: a vendored artifact lands untracked -- the directory is complete, at the right checksum,
 * long before anybody stages it, and a check that read only the index would wave a half-vendored
 * directory through the very run meant to catch it. So `vendor/` is enumerated from the index
 * *and* the working tree. Ignored files stay out: `vendor/`'s own build scratch (`.build/`) is not
 * part of what anyone clones.
 */
const vendoredFiles = lsFiles(["--cached", "--others", "--exclude-standard", "vendor/"]);

/**
 * why: pinning an artifact's digest is the statement that its bytes are someone else's and are not
 * to be read as text, so the same list says which vendored files the text scan must skip -- and the
 * digest test below proves the list means what it says. It also keeps the skip from growing on its
 * own: a new vendored binary joins it by being pinned, not by being named here.
 */
const pinnedVendoredArtifacts = new Set(
  vendoredFiles
    .filter((name) => name.endsWith("/SHA256SUMS.txt"))
    .flatMap((sums) => {
      const dir = sums.slice(0, -"SHA256SUMS.txt".length);
      return sha256Sums(sums).map(([, file]) => `${dir}${file}`);
    }),
);

/** why: the digest and file name a `SHA256SUMS.txt` pins, read in the format `shasum -c` reads. */
function sha256Sums(name: string): [string, string][] {
  return readFileSync(join(REPO_ROOT, name), "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((pair): pair is [string, string] => pair.length === 2 && pair[1]!.length > 0);
}

/**
 * why: a committed binary is never searched as text -- built fixtures the e2e lane installs, and
 * the vendored third-party artifacts a `SHA256SUMS.txt` pins bytes for (a packed server APK). Both kinds hold raw NUL bytes by nature, which is what makes them unsearchable: that
 * is a claim about their contents, so for `vendor/` the test that compares this list against the
 * files in `vendor/` that actually carry a NUL is what makes the skip mean something.
 */
const isCommittedBinary = (name: string): boolean =>
  name.startsWith("e2e/fixtures/") || pinnedVendoredArtifacts.has(name);

/**
 * why: a raw NUL byte in a text file makes `grep` and `ripgrep` classify the whole file as
 * binary and print `binary file matches` instead of the matching lines -- so the file
 * stops being searchable for every human and agent working in this repo. The byte is
 * almost always a `"\0"` escape that was written as the literal character instead.
 *
 * Enumerated from `git ls-files` rather than a directory walk so the check sees every
 * tracked file in the repository (testing rule 4), not just the directories this test
 * happened to name. The exceptions are the committed binaries `isCommittedBinary` names:
 * built binaries committed for tests, and the vendored third-party artifacts, none of
 * which is ever searched as text. Untracked and ignored files are out of scope:
 * they are not part of what anyone clones or searches.
 */
describe("tracked files", () => {
  const trackedFiles = lsFiles([])
    .filter((name) => !isCommittedBinary(name))
    // A submodule or a path deleted from the working tree is still listed by
    // `git ls-files`; only regular files can be read.
    .filter((name) => {
      try {
        return statSync(join(REPO_ROOT, name)).isFile();
      } catch {
        return false;
      }
    });

  it("were enumerated from the git index", () => {
    // Without this, an `execFileSync` that returned nothing would leave `it.each` with an
    // empty list and the suite would pass while checking no file at all.
    expect(trackedFiles.length).toBeGreaterThan(100);
  });

  it("hold no committed binary and still hold e2e/appduct-fixtures.test.ts", () => {
    expect(trackedFiles.filter(isCommittedBinary)).toEqual([]);
    expect(trackedFiles).toContain("e2e/appduct-fixtures.test.ts");
  });

  it("outside the committed binaries contain no raw NUL byte, so grep and ripgrep can search them", () => {
    const offenders = trackedFiles
      .map((name) => ({ name, contents: readFileSync(join(REPO_ROOT, name)) }))
      .filter(({ contents }) => contents.includes(NUL))
      .map(({ name, contents }) => {
        const offset = contents.indexOf(NUL);
        const line = contents.subarray(0, offset).toString("utf8").split("\n").length;
        return `${name}:${line} (byte ${offset})`;
      });

    expect(offenders).toEqual([]);
  });
});

/**
 * why: `vendor/<dir>` is the claim that what is in there is someone else's code, so the check walks
 * every first-level directory (testing rule 4) rather than the two it happens to know about. Built
 * from `vendoredFiles`, which sees the working tree as well as the index.
 */
const vendoredDirs = new Map<string, string[]>();
for (const name of vendoredFiles) {
  const [, dir = "", rest = ""] = name.split("/");
  // why: a file at `vendor/`'s root belongs to no directory, and has its own section below.
  if (rest.length === 0) continue;
  const paths = vendoredDirs.get(dir);
  if (paths === undefined) vendoredDirs.set(dir, [name]);
  else paths.push(name);
}

/** why: a vendored directory's license texts are exactly what its `LICENSES/` holds (rule 3). */
const licenseTextsOf = (dir: string): string[] =>
  (vendoredDirs.get(dir) ?? []).filter((name) => name.startsWith(`vendor/${dir}/LICENSES/`));

/**
 * why: a license text named for a license is all a reader has to trust that it *is*
 * that license, so the name and the contents have to agree; the expected words are
 * read out of the file name (`serve-sim.APACHE-2.0.txt` asks the text to say
 * `APACHE`) so no list here can go stale.
 */
const licensesClaimedOf = (name: string): string[] => {
  const base = name.slice(name.lastIndexOf("/") + 1).replace(/\.txt$/i, "");
  const separator = base.indexOf(".");
  if (separator <= 0) return [];
  return base
    .slice(separator + 1)
    .split(/[.\-_]/)
    .filter((token) => /^[a-z]{2,}$/i.test(token));
};

/**
 * why: some licenses' verbatim text never names the license -- BSD-3-Clause is a copyright line
 * and three conditions -- so a name-word check would reject the verbatim text rule 3 demands. For
 * those, the name is checked against the clause that makes the text that license instead: the
 * third condition is what separates BSD-3-Clause from BSD-2-Clause.
 */
const clauseNamingLicense: Readonly<Record<string, RegExp>> = {
  "BSD-3-Clause": /Neither the name of[\s\S]+?may\s+be\s+used\s+to\s+endorse\s+or\s+promote/,
};

/** why: what in `text` contradicts the license `name` claims to hold, one line per mismatch. */
const licenseMismatchesOf = (name: string, text: string): string[] => {
  const base = name.slice(name.lastIndexOf("/") + 1).replace(/\.txt$/i, "");
  const clause = clauseNamingLicense[base.slice(base.indexOf(".") + 1)];
  if (clause !== undefined) {
    return clause.test(text)
      ? []
      : [`${name}: its text lacks the clause that makes it that license`];
  }
  const claimed = licensesClaimedOf(name);
  if (claimed.length === 0) return [`${name}: its file name names no license`];
  return claimed
    .filter((word) => !new RegExp(`\\b${word}\\b`, "i").test(text))
    .map((word) => `${name}: its text never says ${word}`);
};

/**
 * why: the rule has to be enforced everywhere it applies or it only guards the directories someone
 * remembered (testing rule 4). Vendor and third-party code rule 2
 * (`docs/internal/agent-rules/vendor-and-third-party-code.md`): a first-level directory under
 * `vendor/` holds the artifact(s), the license text(s) they require, and a `NOTICE.md`.
 */
describe("a first-level directory under vendor/", () => {
  it("was enumerated, and holds the vendored code this repo carries", () => {
    // why: without this, an empty enumeration would leave every claim below with nothing to check
    // and the suite would pass while enforcing the rule on no directory at all.
    expect([...vendoredDirs.keys()].toSorted()).toEqual(
      expect.arrayContaining(["scrcpy", "screen-capture"]),
    );
    expect(vendoredFiles.length).toBeGreaterThan(10);
  });

  it("holds a NOTICE.md", () => {
    const withoutNotice = [...vendoredDirs.keys()].filter(
      (dir) => !vendoredDirs.get(dir)?.includes(`vendor/${dir}/NOTICE.md`),
    );
    expect(withoutNotice).toEqual([]);
  });

  it("holds a license text under LICENSES/ whose text matches its name", () => {
    const missing = [...vendoredDirs.keys()].filter((dir) => licenseTextsOf(dir).length === 0);
    const mismatched = [...vendoredDirs.keys()].flatMap((dir) =>
      licenseTextsOf(dir).flatMap((name) =>
        licenseMismatchesOf(name, readFileSync(join(REPO_ROOT, name), "utf8")),
      ),
    );
    expect({ missing, mismatched }).toEqual({ missing: [], mismatched: [] });
  });

  it("holds no file named LICENSE, which would claim to license the whole directory", () => {
    // why: rule 3 -- our own code often sits beside theirs, so a license text names what it covers
    // instead of taking the name that states it covers everything nearby.
    const isBareLicense = (name: string): boolean => /^LICENSE(\.|$)/.test(basename(name));
    const bare = vendoredFiles.filter((name) => name.split("/").length > 2 && isBareLicense(name));
    expect(bare).toEqual([]);
  });
});

/**
 * why: the digest in a `SHA256SUMS.txt` is the claim that a vendored binary is byte-identical to
 * what upstream published, and a claim nobody recomputes is a claim that rots. Computed here rather
 * than read back out of `NOTICE.md`, so both the notice and the text-scan exclusion this list feeds
 * rest on bytes on disk (vendor and third-party code rule 7).
 */
describe("a vendored artifact pinned by a SHA256SUMS.txt", () => {
  const pinned = [...pinnedVendoredArtifacts].toSorted();

  it("was enumerated, and holds the artifacts that are here", () => {
    // why: without this, a `SHA256SUMS.txt` that stopped being listed would empty the two checks
    // below and the suite would pass having verified no digest at all.
    expect(pinned).toEqual(expect.arrayContaining(["vendor/scrcpy/scrcpy-server-v5.0.1"]));
  });

  it("matches the digest its SHA256SUMS.txt gives", () => {
    const wrong = pinned.flatMap((name) => {
      const separator = name.lastIndexOf("/");
      const sums = sha256Sums(`${name.slice(0, separator + 1)}SHA256SUMS.txt`);
      const expected = sums.find(([, file]) => file === name.slice(separator + 1))?.[0];
      if (expected === undefined) return [`${name}: its SHA256SUMS.txt does not list it`];
      const actual = createHash("sha256")
        .update(readFileSync(join(REPO_ROOT, name)))
        .digest("hex");
      return actual === expected ? [] : [`${name}: ${actual} != ${expected}`];
    });
    expect(wrong).toEqual([]);
  });

  it("is exactly the vendored file that a raw NUL byte would make unsearchable", () => {
    // why: this proves the vendored clause of `isCommittedBinary` skips what it says it skips -- an
    // artifact pinned but not a binary is skipped for no reason, which costs every reader a
    // searchable file, and a binary left off the list turns the NUL check red instead of being
    // excluded from it.
    const withNul = vendoredFiles
      .filter((name) => {
        try {
          return statSync(join(REPO_ROOT, name)).isFile();
        } catch {
          return false;
        }
      })
      .filter((name) => readFileSync(join(REPO_ROOT, name)).includes(NUL))
      .toSorted();
    expect(withNul).toEqual(["vendor/scrcpy/scrcpy-server-v5.0.1"]);
    expect(pinned).toEqual(withNul);
  });
});

/**
 * why: a loose file at `vendor/`'s root would sit outside the per-directory rule entirely, so the
 * index is the only one allowed there.
 */
describe("a file at vendor/'s root", () => {
  it("is only the index, never third-party code outside a directory", () => {
    const rootFiles = vendoredFiles.filter((name) => !name.slice("vendor/".length).includes("/"));
    expect(rootFiles).toEqual(["vendor/README.md"]);
  });
});

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

type SizedFile = { path: string; lines: number };

/**
 * why: ADR 0063 section 3. These files were over their limit when the size test landed; each may
 * only shrink. A PR that has to grow one raises its number here, as a visible line of its diff.
 */
const SHRINK_ONLY: Record<string, number> = {
  "src/agent-device/edge.test.ts": 4506,
  "src/cli/index.test.ts": 11542,
  "src/contract/schemas.ts": 1497,
  "src/core/config.test.ts": 2519,
  "src/core/doctor.test.ts": 3534,
  "src/core/registry.test.ts": 2901,
  "src/core/warm-pool/converger.test.ts": 2965,
  "src/daemon/dispatcher.test.ts": 6284,
  "src/daemon/main.test.ts": 5255,
  "src/daemon/main.ts": 1916,
  "src/daemon/server.test.ts": 4380,
  "src/daemon/server.ts": 1803,
  "src/drivers/android/index.test.ts": 6169,
  "src/drivers/android/index.ts": 1831,
  "src/drivers/ios/index.test.ts": 5873,
  "src/drivers/ios/index.ts": 2671,
  "src/gateway/dispatcher.test.ts": 3022,
  "src/gateway/fleet-coordinator.test.ts": 5283,
  "src/gateway/fleet-coordinator.ts": 1659,
  "src/http/app.test.ts": 3487,
  "src/leasing/create-leasing.test.ts": 5276,
  "src/leasing/lease-acquisition-coordinator.test.ts": 3691,
  "src/leasing/lease-acquisition-coordinator.ts": 1622,
};

const CODE_LIMIT = 1400;
const TEST_LIMIT = 2500;

const TEST_FILE_NAME = /(?:\.test\.|\.spec\.)|^test-|^testing\./;

const sizeFailures = (files: SizedFile[], shrinkOnly: Record<string, number>): string[] => {
  const tracked = new Set(files.map((file) => file.path));
  const fileFailures = files.flatMap(({ path, lines }) => {
    const isTest = TEST_FILE_NAME.test(basename(path));
    const limit = isTest ? TEST_LIMIT : CODE_LIMIT;
    const listed = shrinkOnly[path];
    if (listed === undefined) {
      return lines > limit
        ? [
            `${path}: ${lines} lines; a ${isTest ? "test" : "code"} file may have at most ${limit}. Split it (ADR 0063).`,
          ]
        : [];
    }
    if (lines <= limit) {
      return [
        `${path}: ${lines} lines, within its limit now. Remove it from the shrink-only list.`,
      ];
    }
    return lines > listed
      ? [
          `${path}: ${lines} lines, longer than its listed ${listed}. A listed file may only shrink (ADR 0063).`,
        ]
      : [];
  });
  const goneFailures = Object.keys(shrinkOnly)
    .filter((path) => !tracked.has(path))
    .map((path) => `${path}: listed but not tracked. Remove it from the shrink-only list.`);
  return [...fileFailures, ...goneFailures];
};

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
 * the vendored third-party artifacts a `SHA256SUMS.txt` pins bytes for (a packed server APK), and
 * the website's fonts and images. All of them hold raw NUL bytes by nature, which is what makes them unsearchable: that
 * is a claim about their contents, so for `vendor/` the test that compares this list against the
 * files in `vendor/` that actually carry a NUL is what makes the skip mean something.
 */
const isCommittedBinary = (name: string): boolean =>
  name.startsWith("e2e/fixtures/") || pinnedVendoredArtifacts.has(name) || isWebsiteAsset(name);

/**
 * why: the website ships its own fonts and the images `pnpm og` renders (the social card, the
 * README banner, the icons); they are pictures and type, never searched as text. Only those
 * kinds under `website/` are skipped, so a NUL in any of its code still fails.
 */
const isWebsiteAsset = (name: string): boolean =>
  /^website\/(public|src\/fonts)\/[^/]+\.(woff2|png|jpg)$/.test(name);

/**
 * why: a raw NUL byte in a text file makes `grep` and `ripgrep` classify the whole file as
 * binary and print `binary file matches` instead of the matching lines -- so the file
 * stops being searchable for every human and agent working in this repo. The byte is
 * almost always a `"\0"` escape that was written as the literal character instead.
 *
 * Enumerated from `git ls-files` rather than a directory walk so the check sees every
 * tracked file in the repository (testing rule 4), not just the directories this test
 * happened to name. The exceptions are the committed binaries `isCommittedBinary` names:
 * built binaries committed for tests, the vendored third-party artifacts, and the
 * website's fonts and images, none of which is ever searched as text. Untracked and ignored files are out of scope:
 * they are not part of what anyone clones or searches.
 */
describe("tracked files", () => {
  const trackedFiles = lsFiles([])
    .filter((name) => !isCommittedBinary(name))
    // why: A submodule or a path deleted from the working tree is still listed by
    // `git ls-files`; only regular files can be read.
    .filter((name) => {
      try {
        return statSync(join(REPO_ROOT, name)).isFile();
      } catch {
        return false;
      }
    });

  const SIZED_EXTENSIONS = /\.(ts|tsx|mts|mjs|js|cjs)$/;
  const SIZED_DIRECTORIES = /^(src|ui|e2e|scripts|\.agents\/scripts)\//;
  const trackedSizes = trackedFiles
    .filter((name) => SIZED_DIRECTORIES.test(name) && SIZED_EXTENSIONS.test(name))
    .map((name) => ({
      path: name,
      lines: readFileSync(join(REPO_ROOT, name)).filter((byte) => byte === 0x0a).length,
    }));

  it("fails a file over its size limit that is not on the shrink-only list, naming the file, its lines and the limit", () => {
    const failures = sizeFailures(
      [
        { path: "src/a/ok.ts", lines: 1400 },
        { path: "src/a/big.ts", lines: 1401 },
        { path: "src/a/ok.test.ts", lines: 2500 },
        { path: "src/a/big.test.ts", lines: 2501 },
        { path: "src/a/test-x.ts", lines: 2501 },
        { path: "src/a/testing.ts", lines: 2501 },
      ],
      {},
    );
    expect(failures).toEqual([
      "src/a/big.ts: 1401 lines; a code file may have at most 1400. Split it (ADR 0063).",
      "src/a/big.test.ts: 2501 lines; a test file may have at most 2500. Split it (ADR 0063).",
      "src/a/test-x.ts: 2501 lines; a test file may have at most 2500. Split it (ADR 0063).",
      "src/a/testing.ts: 2501 lines; a test file may have at most 2500. Split it (ADR 0063).",
    ]);
    expect(
      sizeFailures(trackedSizes, SHRINK_ONLY).filter((line) => line.includes("may have at most")),
    ).toEqual([]);
  });

  it("fails a listed file that grew past its listed length or no longer needs the entry", () => {
    const list = {
      "src/a/same.ts": 1500,
      "src/a/shrunk.ts": 1500,
      "src/a/grew.ts": 1500,
      "src/a/under.ts": 1500,
      "src/a/gone.ts": 1500,
    };
    expect(
      sizeFailures(
        [
          { path: "src/a/same.ts", lines: 1500 },
          { path: "src/a/shrunk.ts", lines: 1450 },
          { path: "src/a/grew.ts", lines: 1501 },
          { path: "src/a/under.ts", lines: 1400 },
        ],
        list,
      ),
    ).toEqual([
      "src/a/grew.ts: 1501 lines, longer than its listed 1500. A listed file may only shrink (ADR 0063).",
      "src/a/under.ts: 1400 lines, within its limit now. Remove it from the shrink-only list.",
      "src/a/gone.ts: listed but not tracked. Remove it from the shrink-only list.",
    ]);
    expect(
      sizeFailures(trackedSizes, SHRINK_ONLY).filter((line) => !line.includes("may have at most")),
    ).toEqual([]);
  });

  it("were enumerated from the git index", () => {
    // why: Without this, an `execFileSync` that returned nothing would leave `it.each` with an
    // empty list and the suite would pass while checking no file at all.
    expect(trackedFiles.length).toBeGreaterThan(100);
  });

  it("hold no committed binary and still hold e2e/appduct-fixtures.test.ts", () => {
    expect(trackedFiles.filter(isCommittedBinary)).toEqual([]);
    expect(isWebsiteAsset("website/src/fonts/Switzer-Regular.woff2")).toBe(true);
    expect(isWebsiteAsset("website/src/site/content.ts")).toBe(false);
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
 * and three conditions, MIT's is a permission grant with no title -- so a name-word check would
 * reject the verbatim text rule 3 demands. For those, the name is checked against the clause that
 * makes the text that license instead: the third condition is what separates BSD-3-Clause from
 * BSD-2-Clause, and the grant-plus-inclusion pair is what an MIT/Expat text is.
 */
const clauseNamingLicense: Readonly<Record<string, RegExp>> = {
  "BSD-3-Clause": /Neither the name of[\s\S]+?may\s+be\s+used\s+to\s+endorse\s+or\s+promote/,
  MIT: /Permission is hereby granted, free of charge[\s\S]{0,2000}?shall be included in all copies/,
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

/**
 * why: `docs/internal/VENDORED-CODE.md` and `vendor/README.md` are the inventory a reader trusts
 * to list what `vendor/` carries (vendor and third-party code rule 11), so both are checked against
 * the directories on disk, and every `vendor/` path an inventory row names must still be there.
 */
describe("the vendored inventory", () => {
  const inventory = readFileSync(join(REPO_ROOT, "docs/internal/VENDORED-CODE.md"), "utf8");
  const section = inventory.split(/^## /m).find((part) => part.startsWith("The inventory")) ?? "";
  const cells = (row: string): string[] =>
    row
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
  const [header = "", , ...rows] = section.split("\n").filter((line) => line.startsWith("|"));
  const where = cells(header).indexOf("Where it lives");
  const backticked = (text: string): string[] =>
    [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");

  it("was parsed: a row per inventory entry, with a Where it lives column", () => {
    expect(where).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThanOrEqual(vendoredDirs.size);
  });

  it("names every first-level directory under vendor/ in a row's Where it lives column and in vendor/README.md", () => {
    const placed = rows.flatMap((row) => backticked(cells(row)[where] ?? ""));
    const index = readFileSync(join(REPO_ROOT, "vendor/README.md"), "utf8");
    const missing = [...vendoredDirs.keys()].flatMap((dir) => [
      ...(placed.some((path) => path.startsWith(`vendor/${dir}/`))
        ? []
        : [`VENDORED-CODE.md: vendor/${dir}/`]),
      ...(index.includes(`\`${dir}/\``) ? [] : [`vendor/README.md: ${dir}/`]),
    ]);

    expect(missing).toEqual([]);
  });

  it("names only vendor/ paths that exist", () => {
    const gone = rows
      .flatMap(backticked)
      .filter((token) => /^vendor\/\S+$/.test(token))
      .filter((path) => {
        try {
          statSync(join(REPO_ROOT, path));
          return false;
        } catch {
          return true;
        }
      });

    expect(gone).toEqual([]);
  });
});

const workflowFiles = lsFiles([".github/workflows/"]).filter((name) => /\.ya?ml$/.test(name));

function workflowLines(pattern: RegExp): string[] {
  return workflowFiles.flatMap((name) =>
    readFileSync(join(REPO_ROOT, name), "utf8")
      .split("\n")
      .flatMap((line, index) =>
        pattern.test(line) ? [`${name}:${index + 1}: ${line.trim()}`] : [],
      ),
  );
}

/**
 * why: a dependency's lifecycle script runs arbitrary code inside a job that may hold a token, and
 * a credential written into a URL lands in the process list and in any log that echoes the remote.
 */
describe("a GitHub workflow", () => {
  it("was enumerated from the git index", () => {
    expect(workflowFiles).toContain(".github/workflows/release.yml");
    expect(workflowFiles).toContain(".github/workflows/website.yml");
  });

  it("passes --ignore-scripts to every pnpm install", () => {
    const installs = workflowLines(/\bpnpm install\b/);
    expect(installs.length).toBeGreaterThan(1);
    expect(installs.filter((line) => !line.includes("--ignore-scripts"))).toEqual([]);
  });

  it("writes no credential into a URL", () => {
    expect(workflowLines(/https?:\/\/[^/"'\n]*@/)).toEqual([]);
  });
});

describe("the Release workflow's push (.github/workflows/release.yml)", () => {
  const release = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  const step = /\n {6}- name: Push\n[\s\S]*?(?=\n {6}- |\n\n)/.exec(release)?.[0] ?? "";
  const push = /git push(?:[^\n]*\\\n)*[^\n]*/.exec(step)?.[0] ?? "";

  it("sends the token as the extraheader actions/checkout sets, through git's GIT_CONFIG_* environment, so it is in neither the remote URL nor git's arguments", () => {
    expect(step).toContain(
      `auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\\n')`,
    );
    expect(step).toContain(`echo "::add-mask::$auth"`);
    const exported = [
      `export GIT_CONFIG_COUNT=1`,
      `export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"`,
      `export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"`,
    ];
    for (const line of exported) {
      expect(step).toContain(line);
      expect(step.indexOf(line)).toBeLessThan(step.indexOf("git push"));
    }
    expect(push).toContain(`"https://github.com/\${GITHUB_REPOSITORY}.git"`);
    expect(push).not.toMatch(/GITHUB_TOKEN|\$auth|\s-c\s/);
  });

  it("still pushes the release commit and its tag atomically, leased on the commit the plan checked", () => {
    expect(push).toContain("--atomic");
    expect(push).toContain(`--force-with-lease="refs/heads/main:$GITHUB_SHA"`);
    expect(push).toContain(`HEAD:refs/heads/main "refs/tags/$TAG"`);
  });
});

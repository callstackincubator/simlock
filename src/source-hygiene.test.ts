import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const NUL = 0x00;

/**
 * A raw NUL byte in a text file makes `grep` and `ripgrep` classify the whole file as
 * binary and print `binary file matches` instead of the matching lines -- so the file
 * stops being searchable for every human and agent working in this repo. The byte is
 * almost always a `"\0"` escape that was written as the literal character instead.
 *
 * Enumerated from `git ls-files` rather than a directory walk so the check sees every
 * tracked file in the repository (testing rule 4), not just the directories this test
 * happened to name. Untracked and ignored files are out of scope: they are not part of
 * what anyone clones or searches.
 */
describe("tracked files", () => {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((name) => name.length > 0)
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

  it("contain no raw NUL byte, so grep and ripgrep can search them", () => {
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

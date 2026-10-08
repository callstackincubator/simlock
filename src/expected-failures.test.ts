import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stripComments } from "./test-support/imports.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A call that registers a test written to pass by failing: `it.fails`, `test.fails`,
 * `describe.fails`, and the same on `.each(...)` or `.skipIf(...)`. An `it.skip` or `it.todo`
 * says plainly that it proved nothing; an expected failure reports green while proving nothing,
 * which is what makes it invisible to a suite read from the top.
 *
 * Read from comment-stripped text (the same scanner every boundary test uses), so prose that
 * merely names the API is not a hit.
 */
const EXPECTED_FAILURE = /\b(?:it|test|describe)(?:\.[A-Za-z]+(?:\([^()]*\))?)*\.fails\s*\(/;

/**
 * Every tracked test file. Enumerated from `git ls-files` rather than a directory walk, so the
 * check sees every test in the repository -- `src/`, `e2e/` and `ui/` alike -- and not only the
 * directories this file names (testing rule 4).
 */
const testFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.test.ts", "*.test.tsx", "*.spec.ts"],
  { cwd: REPO_ROOT, encoding: "utf8" },
)
  .split("\0")
  .filter((name) => name.length > 0)
  // A path deleted from the working tree is still listed by `git ls-files`; only regular files
  // can be read.
  .filter((name) => {
    try {
      return statSync(join(REPO_ROOT, name)).isFile();
    } catch {
      return false;
    }
  });

describe("the tracked test files", () => {
  it("were enumerated from the git index, in `src/`, `e2e/` and `ui/` alike", () => {
    // Without this, a pathspec or a `cwd` that matched nothing would leave the scan below with no
    // file to read and the suite would pass while checking no test at all. One file from each tree
    // proves the scan reaches all three: `e2e/` is where the file this rule is about lives.
    for (const tree of ["src", "e2e", "ui"]) {
      expect(
        testFiles.some((name) => name.startsWith(`${tree}/`)),
        `no tracked test file found under ${tree}/`,
      ).toBe(true);
    }
  });

  it("hold no test written to pass by failing", () => {
    const offenders = testFiles.flatMap((name) =>
      stripComments(readFileSync(join(REPO_ROOT, name), "utf8"))
        .split("\n")
        .flatMap((line, index) =>
          EXPECTED_FAILURE.test(line) ? [`${name}:${index + 1}: ${line.trim()}`] : [],
        ),
    );

    expect(offenders).toEqual([]);
  });
});

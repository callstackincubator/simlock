import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stripComments } from "./test-support/imports.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// why: matched against comment-stripped text, so prose that merely names the API is not a hit.
const EXPECTED_FAILURE = /\b(?:it|test|describe)(?:\.[A-Za-z]+(?:\([^()]*\))?)*\.fails\s*\(/;

// why: enumerated from `git ls-files` rather than a directory walk, so the scan reaches every
// tree the rule covers and not only the ones this file happens to name (testing rule 4).
const testFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.test.ts", "*.test.tsx", "*.spec.ts"],
  { cwd: REPO_ROOT, encoding: "utf8" },
)
  .split("\0")
  .filter((name) => name.length > 0)
  // why: `git ls-files` still lists a path deleted from the working tree, and only a regular
  // file can be read.
  .filter((name) => {
    try {
      return statSync(join(REPO_ROOT, name)).isFile();
    } catch {
      return false;
    }
  });

describe("the tracked test files", () => {
  it("were enumerated from the git index, in `src/`, `e2e/` and `ui/` alike", () => {
    // why: a pathspec or a `cwd` that matched nothing would leave the scan below with no file to
    // read, and the rule would read as covered while proving nothing.
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

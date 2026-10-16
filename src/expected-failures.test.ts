import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stripComments } from "./test-support/imports.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * why: matched against a whole comment-stripped file rather than line by line, so a call whose
 * table spans several lines is still found, and prose that merely names the API is not a hit.
 * why: the modifier chain is allowed on both sides of `fails` because that is where vitest puts it
 * (`it.only` and `fails.each` are both real modifiers there), and a guard with a hole reads as
 * coverage the suite no longer has.
 */
const EXPECTED_FAILURE =
  /\b(?:it|test|describe)(?:\.[A-Za-z]+(?:\([^()]*\))?)*\.fails\b(?:\.[A-Za-z]+(?:\([^()]*\))?)*\(/g;

// why: each chain is held in pieces and without its arguments, because a string holding the whole
// call is text the scan below reads and this file would then name itself as an offender.
const expectedFailureSpellings: { shape: string; parts: string[] }[] = [
  { shape: "it.fails", parts: ["it", "fails"] },
  { shape: "test.fails", parts: ["test", "fails"] },
  { shape: "describe.fails", parts: ["describe", "fails"] },
  { shape: "it.skipIf(false).fails", parts: ["it", "skipIf(false)", "fails"] },
  { shape: "it.only.fails", parts: ["it", "only", "fails"] },
  { shape: "it.fails.each", parts: ["it", "fails", "each([[1, 2]])"] },
  { shape: "it.fails.only", parts: ["it", "fails", "only"] },
  { shape: "it.fails.concurrent", parts: ["it", "fails", "concurrent"] },
  { shape: "it.fails.skipIf", parts: ["it", "fails", "skipIf(flag)"] },
];

// why: a matcher that fires on `it.skip` or a bare `it` would hold back code the suite needs, so
// the shapes it must leave alone are pinned beside the ones it must catch.
const otherRegistrations: { shape: string; parts: string[] }[] = [
  { shape: "it.skip", parts: ["it", "skip"] },
  { shape: "it.todo", parts: ["it", "todo"] },
  { shape: "it.only", parts: ["it", "only"] },
  { shape: "it", parts: ["it"] },
  { shape: "expect(promise).rejects.toThrow", parts: ["expect(promise)", "rejects", "toThrow"] },
];

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

function expectedFailuresIn(text: string, name: string): string[] {
  const stripped = stripComments(text);
  const found: string[] = [];
  for (const match of stripped.matchAll(EXPECTED_FAILURE)) {
    const line = stripped.slice(0, match.index).split("\n").length;
    found.push(`${name}:${line}: ${(match[0] ?? "").split("\n")[0]?.trim() ?? ""}`);
  }
  return found;
}

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
      expectedFailuresIn(readFileSync(join(REPO_ROOT, name), "utf8"), name),
    );

    expect(offenders).toEqual([]);
  });
});

describe("the expected-failure matcher", () => {
  it.each(expectedFailureSpellings)("finds the expected failure in `$shape`", ({ parts }) => {
    const call = `${parts.join(".")}("a title", () => {})`;

    expect(expectedFailuresIn(call, "probe.test.ts")).toHaveLength(1);
  });

  it.each(otherRegistrations)("finds no expected failure in `$shape`", ({ parts }) => {
    const call = `${parts.join(".")}("a title", () => {})`;

    expect(expectedFailuresIn(call, "probe.test.ts")).toEqual([]);
  });

  it("matches a call whose table is written across several lines", () => {
    // why: the call's head is assembled here rather than written out, because a string holding
    // the whole call is text the scanner reads and would count against this file.
    const call = [
      `${["it", "fails", "each"].join(".")}([`,
      "  [1, 2],",
      "])(",
      '  "a title",',
      "  (a, b) => {},",
      ")",
    ].join("\n");

    // why: the expected offender is rebuilt from `call` rather than written out, because a string
    // holding the whole call is text this file's own scan reads, and it would then name itself.
    expect(expectedFailuresIn(call, "probe.test.ts")).toEqual([
      `probe.test.ts:1: ${call.split("\n")[0]}`,
    ]);
  });

  it("reports the line the call is written on, even below a multi-line comment", () => {
    // why: the offender is reported as path and line so a reader opens the file at the right
    // place; a comment stripped without its newlines would point them at the header instead.
    const file = [
      "/*",
      " * a header",
      " * of several",
      " */",
      `${["it", "fails"].join(".")}("a title", () => {})`,
    ].join("\n");
    // why: the expected report line is assembled from pieces like the calls above, because a
    // string holding the whole call is text this file's own scan reads, and it would name itself.
    expect(expectedFailuresIn(file, "probe.test.ts")).toEqual([
      `probe.test.ts:5: ${["it", "fails("].join(".")}`,
    ]);
  });

  it("does not report a hit for prose that only names the API", () => {
    // why: built in pieces for the same reason as the call above — a string holding the whole call
    // is text this file's own scan reads, and it would then name itself.
    const named = `// ${["it", "fails", "each([[1, 2]])"].join(".")}("a title", () => {})`;
    const withProse = [named, 'it.todo("a title")'].join("\n");

    expect(expectedFailuresIn(withProse, "probe.test.ts")).toEqual([]);
  });
});

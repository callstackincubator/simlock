import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "fix-kind.mjs",
);
const SOURCE = "src/a.ts";
const TEST = "src/a.test.ts";
const IMAGE = "src/a.png";
const lines = (...all: string[]) => `${all.join("\n")}\n`;
const BASE_SOURCE = lines("one", "two", "three", "four", "five", "six", "seven");
const PR_SOURCE = BASE_SOURCE.replace("two", "two by the PR");
const WORKFLOW = ".github/workflows/ci.yml";
const PR_WORKFLOW = lines("on:", "  push:", "    branches: [main]");
const PR_TEST = lines(
  "const LIMIT = 20;",
  'const NAME = "case 1";',
  "const WAIT = 5; // seconds: 5",
  "it.each([",
  '  ["adds", 1, 2],',
  '])("%s", (_, a, sum) => {',
  "  expect(add(a, a)).toBe(sum);",
  "}, 30_000);",
  "/*",
  " waits 20 s",
  "*/",
  "const LABEL = `sum`;",
  "const AFTER = 5;",
);
const NUMBERS = PR_TEST.replace("= 20;", "= 60;")
  .replace("30_000", "60_000")
  .replace("1, 2]", "1, 3]");
const UNSURE = "more than a number outside strings and comments changed";

// why: a conflict makes git exit 1 with the merge left open, which each case then resolves and
// commits; the identity is given here because CI's git has none, and a merge refuses without one.
function mergeMain(dir: string): void {
  spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-commit", "--no-ff", "main"],
    { cwd: dir },
  );
  execFileSync("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], { cwd: dir });
}

interface Finding {
  readonly id: string;
  readonly outcome: string;
}

// why: `main` holds the source file, `task` changes one line of it and adds a test; that
// commit is the reviewed one, and each case adds what came after the review.
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "fix-kind-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  const commit = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", ".");
    git("commit", "-qm", "c");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  commit({ [SOURCE]: BASE_SOURCE });
  git("switch", "-qc", "task");
  const previous = commit({
    [SOURCE]: PR_SOURCE,
    [TEST]: PR_TEST,
    [IMAGE]: "\0one",
    [WORKFLOW]: PR_WORKFLOW,
  });
  const onMain = (files: Readonly<Record<string, string>>) => {
    git("switch", "-q", "main");
    commit(files);
    git("switch", "-q", "task");
  };
  const check = (findings: readonly Finding[] = [], from = previous) => {
    const file = join(dir, "findings.json");
    writeFileSync(file, JSON.stringify({ findings }));
    const result = spawnSync(
      process.execPath,
      [SCRIPT, from, "HEAD", "--base", "main", "--findings", file],
      { cwd: dir, encoding: "utf8" },
    );
    return { status: result.status, stdout: result.stdout };
  };
  return { check, commit, dir, git, onMain, previous };
}

// why: each case builds a repository with about fifteen git processes, which pass the 20 s default on a loaded Windows runner.
describe("fix-kind.mjs", { timeout: 60_000 }, () => {
  it.each([
    ["merged cleanly two lines from the PR's own", "four", "four by main"],
    ["conflicted on the next line and kept both sides", "three", "three by main"],
  ])("passes a merge of a base that %s", (_, line, byMain) => {
    const { check, dir, git, onMain } = repository();
    onMain({ [SOURCE]: BASE_SOURCE.replace(line, byMain) });
    mergeMain(dir);
    writeFileSync(join(dir, SOURCE), PR_SOURCE.replace(line, byMain));
    git("add", ".");
    git("commit", "-qm", "merge");

    const result = check();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^verified by: script \(fix-kind \w{9}\.\.\w{9}: the PR adds and removes the same lines\)\n$/,
    );
  });

  it.each([
    ["numbers outside every string and comment", NUMBERS],
    ["a blank line above every template literal", `\n${PR_TEST}`],
  ])("passes a fix that changes only %s in a test script", (_, text) => {
    const { check, commit } = repository();
    commit({ [TEST]: text });

    expect(check()).toEqual({
      status: 0,
      stdout: expect.stringContaining(`only numbers in test code changed: ${TEST})`),
    });
  });

  it.each([
    ["a source file", { [SOURCE]: PR_SOURCE.replace("six", "six again") }, `${SOURCE}: not a test`],
    ["a doc", { "src/AGENTS.md": "- a rule\n" }, "src/AGENTS.md: not a test script"],
    ["a binary file beside a test", { [IMAGE]: "\0two", [TEST]: NUMBERS }, `${IMAGE}: not a test`],
    [
      "a doc among the e2e tests",
      { "e2e/README.md": "text\n" },
      "e2e/README.md: not a test script",
    ],
    ["a fixture among the e2e tests", { "e2e/a.json": "{}\n" }, "e2e/a.json: not a test script"],
    ["a test with JSX", { "src/b.dom.test.tsx": "x\n" }, "src/b.dom.test.tsx: not a test script"],
    [
      "only the indentation of a line the PR added",
      { [WORKFLOW]: PR_WORKFLOW.replace("    branches", "  branches") },
      `${WORKFLOW}: not a test script`,
    ],
    [
      "a title in a one-line table row",
      { [TEST]: PR_TEST.replace('"adds"', '"sums"') },
      `${TEST}: ${UNSURE}: "["sums", 1, 2],"`,
    ],
    [
      "a title given to it.each",
      { [TEST]: PR_TEST.replace('"%s"', '"%s twice"') },
      `${TEST}: ${UNSURE}: "])("%s twice", (_, a, sum) => {"`,
    ],
    [
      "a number inside a string",
      { [TEST]: PR_TEST.replace("case 1", "case 2") },
      `${TEST}: ${UNSURE}: "const NAME = "case 2";"`,
    ],
    [
      "a number in a trailing comment",
      { [TEST]: PR_TEST.replace("seconds: 5", "seconds: 6") },
      `${TEST}: ${UNSURE}: "const WAIT = 5; // seconds: 6"`,
    ],
    [
      "a number inside a block comment",
      { [TEST]: PR_TEST.replace("waits 20 s", "waits 30 s") },
      `${TEST}: ${UNSURE}: "waits 20 s"`,
    ],
    [
      "a number below a template literal",
      { [TEST]: PR_TEST.replace("AFTER = 5", "AFTER = 6") },
      `${TEST}: ${UNSURE}: "const AFTER = 5;"`,
    ],
    [
      "a call in a test",
      { [TEST]: PR_TEST.replace("toBe(sum)", "toEqual(sum)") },
      `${TEST}: ${UNSURE}: "expect(add(a, a)).toEqual(sum);"`,
    ],
    [
      "a comment in a test",
      { [TEST]: `// why: the sum is exact\n${PR_TEST}` },
      `${TEST}: ${UNSURE}: "// why: the sum is exact"`,
    ],
  ])("sends a fix that changes %s to the fix-check", (_, files, reason) => {
    const { check, commit } = repository();
    commit(files);

    const result = check();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`fix-kind: ${reason}`);
  });

  it("sends a merge whose conflict resolution rewrote the PR's line to the fix-check", () => {
    const { check, dir, git, onMain } = repository();
    onMain({ [SOURCE]: BASE_SOURCE.replace("two", "two by main") });
    mergeMain(dir);
    writeFileSync(join(dir, SOURCE), BASE_SOURCE.replace("two", "two by both"));
    git("add", ".");
    git("commit", "-qm", "merge");

    expect(check()).toEqual({ status: 1, stdout: `fix-kind: ${SOURCE}: not a test script\n` });
  });

  it("sends any fix to the fix-check while a finding is open", () => {
    const { check, commit } = repository();
    commit({ [TEST]: NUMBERS });

    expect(
      check([
        { id: "R1", outcome: "fixed" },
        { id: "R2", outcome: "open" },
      ]),
    ).toEqual({
      status: 1,
      stdout: "fix-kind: R2: the finding is open, and its fix needs the check\n",
    });
  });

  it("sends a rebased branch to the fix-check", () => {
    const { check, commit, git, onMain, previous } = repository();
    onMain({ "src/b.ts": "by main\n" });
    git("switch", "-q", "main");
    git("switch", "-qc", "rebased");
    commit({ [SOURCE]: PR_SOURCE, [TEST]: PR_TEST });

    const result = check([], previous);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not an ancestor of the head; a rebase needs the check");
  });

  it("exits 2 on a commit the clone lacks, and without its arguments", () => {
    const { dir } = repository();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });

    const unknown = run("0".repeat(40), "HEAD", "--base", "main", "--findings", "f.json");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("is no commit here: git fetch origin");
    expect(run("HEAD", "HEAD").stderr).toContain("usage: fix-kind.mjs <previous> <head>");
  });
});

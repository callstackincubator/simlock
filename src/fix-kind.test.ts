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
const lines = (...all: string[]) => `${all.join("\n")}\n`;
const BASE_SOURCE = lines("one", "two", "three", "four", "five", "six", "seven");
const PR_SOURCE = BASE_SOURCE.replace("two", "two by the PR");
const PR_TEST = lines('it("adds", () => {', "  expect(add(1, 1)).toBe(2);", "});");

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
  const previous = commit({ [SOURCE]: PR_SOURCE, [TEST]: PR_TEST });
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
    spawnSync("git", ["merge", "-q", "--no-commit", "--no-ff", "main"], { cwd: dir });
    writeFileSync(join(dir, SOURCE), PR_SOURCE.replace(line, byMain));
    git("add", ".");
    git("commit", "-qm", "merge");

    const result = check();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^verified by: script \(fix-kind \w{9}\.\.\w{9}: the PR adds and removes the same lines\)\n$/,
    );
  });

  it("passes a fix that changes only an assertion in a test file", () => {
    const { check, commit } = repository();
    commit({ [TEST]: PR_TEST.replace("toBe(2)", "toEqual(2)") });

    expect(check()).toEqual({
      status: 0,
      stdout: expect.stringContaining(`only test code changed: ${TEST})`),
    });
  });

  it.each([
    ["a source file", { [SOURCE]: PR_SOURCE.replace("six", "six again") }, `${SOURCE}: not a test`],
    ["a doc", { "src/AGENTS.md": "- a rule\n" }, "src/AGENTS.md: not a test file"],
    ["a doc among the e2e tests", { "e2e/README.md": "text\n" }, "e2e/README.md: not a test file"],
    [
      "a test title",
      { [TEST]: PR_TEST.replace('"adds"', '"adds two numbers"') },
      `${TEST}: a comment or test title changed: "it("adds", () => {"`,
    ],
    [
      "a comment in a test",
      { [TEST]: `// why: the sum is exact\n${PR_TEST}` },
      `${TEST}: a comment or test title changed: "// why: the sum is exact"`,
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
    spawnSync("git", ["merge", "-q", "--no-commit", "--no-ff", "main"], { cwd: dir });
    writeFileSync(join(dir, SOURCE), BASE_SOURCE.replace("two", "two by both"));
    git("add", ".");
    git("commit", "-qm", "merge");

    expect(check()).toEqual({ status: 1, stdout: `fix-kind: ${SOURCE}: not a test file\n` });
  });

  it("sends any fix to the fix-check while a finding is open", () => {
    const { check, commit } = repository();
    commit({ [TEST]: PR_TEST.replace("toBe(2)", "toEqual(2)") });

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

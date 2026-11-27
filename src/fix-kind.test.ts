import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const BASE_SOURCE = `${"header one two three four five six seven open read write close eight nine ten eleven tail"
  .split(" ")
  .join("();\n")}();\n`;
const GUARD = "if (!ok) return;";
const PR_SOURCE = BASE_SOURCE.replace("open();\n", `open();\n${GUARD}\n`);
const PR_TEST = 'it("adds", () => {\n  expect(add(1, 1)).toBe(2);\n});\n';
const CHANGED = "its part of the PR's patch changed";

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

// why: `main` holds the source file, `task` adds one line to it, a test and an image; that
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
  const previous = commit({ [SOURCE]: PR_SOURCE, [TEST]: PR_TEST, [IMAGE]: "\0one" });
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
  it("passes a merge of a base that only moves the PR's hunks to other line numbers", () => {
    const { check, dir, git, onMain } = repository();
    onMain({ [SOURCE]: `preface();\n${BASE_SOURCE}`, "src/b.ts": "by main\n" });
    mergeMain(dir);
    git("commit", "-qm", "merge");

    const result = check();

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^verified by: script \(fix-kind \w{9}\.\.\w{9}: the PR's patch is the same\)\n$/,
    );
  });

  it("sends a merge of a base that changed a line of context beside the PR's line to the fix-check", () => {
    const { check, dir, git, onMain } = repository();
    onMain({ [SOURCE]: BASE_SOURCE.replace("write();", "write(1);") });
    mergeMain(dir);
    git("commit", "-qm", "merge");

    expect(check()).toEqual({ status: 1, stdout: `fix-kind: ${SOURCE}: ${CHANGED}\n` });
  });

  it("sends a merge whose conflict resolution rewrote the PR's line to the fix-check", () => {
    const { check, dir, git, onMain } = repository();
    onMain({ [SOURCE]: BASE_SOURCE.replace("open();\n", "open();\nif (!ready) return;\n") });
    mergeMain(dir);
    writeFileSync(join(dir, SOURCE), PR_SOURCE.replace(GUARD, "if (!ok || !ready) return;"));
    git("add", ".");
    git("commit", "-qm", "merge");

    expect(check()).toEqual({ status: 1, stdout: `fix-kind: ${SOURCE}: ${CHANGED}\n` });
  });

  it.each([
    [
      "moves a line the PR added past lines of the base",
      { [SOURCE]: BASE_SOURCE.replace("write();\n", `write();\n${GUARD}\n`) },
      SOURCE,
    ],
    [
      "re-indents a line the PR added",
      { [SOURCE]: PR_SOURCE.replace(GUARD, `  ${GUARD}`) },
      SOURCE,
    ],
    ["changes a number in a test", { [TEST]: PR_TEST.replace("toBe(2)", "toBe(3)") }, TEST],
    ["changes a binary file", { [IMAGE]: "\0two" }, IMAGE],
    ["adds a file", { "src/AGENTS.md": "- a rule\n" }, "src/AGENTS.md"],
  ])("sends a fix that %s to the fix-check", (_, files, path) => {
    const { check, commit } = repository();
    commit(files);

    expect(check()).toEqual({ status: 1, stdout: `fix-kind: ${path}: ${CHANGED}\n` });
  });

  it("sends a fix that makes a file executable, or renames one, to the fix-check", () => {
    const mode = repository();
    chmodSync(join(mode.dir, SOURCE), 0o755);
    mode.git("update-index", "--chmod=+x", SOURCE);
    mode.git("commit", "-qm", "mode");
    const renamed = repository();
    renamed.git("mv", TEST, "src/b.test.ts");
    renamed.git("commit", "-qm", "rename");

    expect(mode.check()).toEqual({ status: 1, stdout: `fix-kind: ${SOURCE}: ${CHANGED}\n` });
    expect(renamed.check()).toEqual({
      status: 1,
      stdout: `fix-kind: ${TEST}: ${CHANGED}\nfix-kind: src/b.test.ts: ${CHANGED}\n`,
    });
  });

  it("sends an unchanged patch to the fix-check while a finding is open", () => {
    const { check } = repository();

    expect(check([{ id: "R1", outcome: "fixed" }]).status).toBe(0);
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
    commit({ [SOURCE]: PR_SOURCE, [TEST]: PR_TEST, [IMAGE]: "\0one" });

    expect(check([], previous)).toEqual({
      status: 1,
      stdout: expect.stringMatching(
        /^fix-kind: \w{9}: not an ancestor of the head; a rebase needs the check\n$/,
      ),
    });
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

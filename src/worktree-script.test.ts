import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "worktree.sh",
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", file);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-sh-")));
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, main);
  commit(main, "base");
  git(main, "push", "-q", "origin", "HEAD:main");
  git(main, "push", "-q", "origin", "HEAD:task/1");
  git(main, "fetch", "-q", "origin");
  const stage = join(main, ".claude", "worktrees", "agent-red");
  git(main, "worktree", "add", "-q", "--track", "-b", "task/1", stage, "origin/task/1");
  return { root, origin, main, stage };
}

function run(cwd: string, ...args: string[]): string {
  return execFileSync("sh", [SCRIPT, ...args], { cwd, encoding: "utf8" })
    .trim()
    .split("\n")
    .at(-1)!;
}

describe("worktree.sh", () => {
  it("hands every stage of a task the worktree that already holds its branch, fast-forwarded to origin", () => {
    const { root, origin, main, stage } = fixture();
    const elsewhere = join(root, "elsewhere");
    git(root, "clone", "-q", "-b", "task/1", origin, elsewhere);
    const pushed = commit(elsewhere, "green");
    git(elsewhere, "push", "-q", "origin", "task/1");

    expect(run(main, "task/1")).toBe(stage);
    expect(git(stage, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(main, "worktree", "list", "--porcelain")).not.toContain("task-1");
  });

  it("keeps a stage's local commits that origin lacks, and still hands that worktree back", () => {
    const { main, stage } = fixture();
    const local = commit(stage, "audit");

    expect(run(main, "task/1")).toBe(stage);
    expect(git(stage, "rev-parse", "HEAD")).toBe(local);
  });
});

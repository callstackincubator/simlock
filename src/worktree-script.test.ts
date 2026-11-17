import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  it("--detach puts each call in a new folder checked out at the commit asked for", () => {
    const { main } = fixture();
    const first = git(main, "rev-parse", "HEAD");
    const second = commit(main, "next");

    const a = run(main, "--detach", first);
    const b = run(main, "--detach", second);
    const c = run(main, "--detach", second);

    expect(git(a, "rev-parse", "HEAD")).toBe(first);
    expect(git(b, "rev-parse", "HEAD")).toBe(second);
    expect(c).not.toBe(b);
    expect(git(c, "rev-parse", "HEAD")).toBe(second);
    expect(() => run(main, "--detach", "0000000")).toThrow();
  });

  it("--detach takes --prepare before or after the commit, and installs into the new worktree", () => {
    const { root, main } = fixture();
    const bin = join(root, "bin");
    const installs = join(root, "installs");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\n[ "$1" = --version ] && { echo 1.2.3; exit 0; }\npwd >> "${installs}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(main, "package.json"),
      JSON.stringify({ devEngines: { packageManager: { name: "pnpm", version: "1.2.3" } } }),
    );
    git(main, "add", "package.json");
    git(main, "commit", "-qm", "package.json");
    const head = git(main, "rev-parse", "HEAD");
    const detach = (...args: string[]) =>
      execFileSync("sh", [SCRIPT, "--detach", ...args], {
        cwd: main,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }).trim();

    const after = detach(head, "--prepare");
    const before = detach("--prepare", head);

    expect(git(after, "rev-parse", "HEAD")).toBe(head);
    expect(git(before, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(installs, "utf8").trim().split("\n")).toEqual([after, before]);
  });
});

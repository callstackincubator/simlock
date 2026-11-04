import { execFileSync, spawnSync } from "node:child_process";
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
  "checkout-age.mjs",
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", file);
}

function checkout(ahead: number): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "checkout-age-")));
  const origin = join(root, "origin.git");
  const upstream = join(root, "upstream");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, upstream);
  commit(upstream, "base");
  git(upstream, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", origin, work);
  git(work, "switch", "-q", "-c", "work");
  for (let i = 0; i < ahead; i++) commit(upstream, `next-${i}`);
  if (ahead > 0) git(upstream, "push", "-q", "origin", "HEAD:main");
  return work;
}

function run(cwd: string): string {
  return spawnSync("node", [SCRIPT], { input: JSON.stringify({ cwd }), encoding: "utf8" }).stdout;
}

describe("checkout-age.mjs", () => {
  it("fetches main and says how many commits the checkout lacks, naming its branch", () => {
    expect(run(checkout(2))).toContain(
      "This checkout (work) is 2 commits behind origin/main. Code read here may differ from main's",
    );
  });

  it("says nothing for a checkout that has all of main, or a folder that is no checkout", () => {
    expect(run(checkout(0))).toBe("");
    expect(run(realpathSync(mkdtempSync(join(tmpdir(), "checkout-age-none-"))))).toBe("");
  });
});

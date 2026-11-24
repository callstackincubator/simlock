import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEFTHOOK = join(ROOT, "node_modules", ".bin", "lefthook");

// why: the stand-in pnpm fails as `vitest run` does when the branch carries a failing
// *.repo.test.ts, so the step's exit is the hook's verdict on such a push.
function pushRepoTests(branch: string) {
  // why: a git hook runs with GIT_DIR and friends set, which would aim the scratch repo's git calls at this checkout.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) delete process.env[name];
  }
  const repo = mkdtempSync(join(tmpdir(), "push-hook-"));
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"],
    {
      cwd: repo,
    },
  );
  // why: `lefthook dump` drops a skip it has already judged against this checkout's branch, so the scratch repo gets the file itself.
  copyFileSync(join(ROOT, "lefthook.yml"), join(repo, "lefthook.yml"));
  const bin = join(repo, ".bin");
  mkdirSync(bin);
  const calls = join(repo, "pnpm-calls");
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 1\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  const { LEFTHOOK: _off, LEFTHOOK_EXCLUDE: _excluded, ...inherited } = process.env;
  const env = { ...inherited, PATH: `${bin}:${process.env.PATH}` };
  const result = spawnSync(
    LEFTHOOK,
    ["run", "pre-push", "--command", "repo-tests", "--force", "--no-auto-install", "--no-tty"],
    { cwd: repo, env, encoding: "utf8" },
  );
  return {
    status: result.status,
    pnpm: existsSync(calls) ? readFileSync(calls, "utf8") : null,
  };
}

describe("the push hook's repo-tests step", () => {
  it.each(["bug/7-repro", "wip/7-repro"])(
    "does not run the repo tests on %s, whose reproduction fails by design",
    (branch) => {
      expect(pushRepoTests(branch)).toEqual({ status: 0, pnpm: null });
    },
  );

  it("runs every repo test on any other branch and refuses the push when one fails", () => {
    expect(pushRepoTests("task/7")).toEqual({
      status: 1,
      pnpm: "exec vitest run --project unit .repo.test.ts\n",
    });
  });
});

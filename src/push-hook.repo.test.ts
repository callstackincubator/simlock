import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// why: `.bin/lefthook` is a shell shim that Windows cannot start without a shell; the package's own entry
// runs under node on every host.
const LEFTHOOK = join(ROOT, "node_modules", "lefthook", "bin", "index.js");

// why: the stand-in pnpm fails as `vitest run` does when the branch carries a failing
// *.repo.test.ts, so the step's exit is the hook's verdict on such a push.
function pushRepoTests(branch: string) {
  // why: a git hook runs with GIT_DIR set, which would aim the scratch repo's git calls at this checkout.
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
  // why: `lefthook dump` drops a skip it has judged against this checkout's branch, and `--command` ignores one, so the
  // scratch repo gets the step's own block from lefthook.yml and the hook runs there on the scratch branch.
  const block = /^ {4}repo-tests:\n(?: {5,}.*\n|\s*\n)*/m.exec(
    readFileSync(join(ROOT, "lefthook.yml"), "utf8"),
  );
  writeFileSync(join(repo, "lefthook.yml"), `pre-push:\n  commands:\n${block?.[0]}`);
  const bin = join(repo, ".bin");
  mkdirSync(bin);
  const calls = join(repo, "pnpm-calls");
  // why: the hook's shell is Git Bash on Windows, which reads a path with `/` but may not one with `\`.
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\necho "$@" >> "${calls.replaceAll("\\", "/")}"\nexit 1\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const { LEFTHOOK: _off, LEFTHOOK_EXCLUDE: _excluded, ...inherited } = process.env;
  const env = { ...inherited, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const result = spawnSync(
    process.execPath,
    [LEFTHOOK, "run", "pre-push", "--force", "--no-auto-install", "--no-tty"],
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

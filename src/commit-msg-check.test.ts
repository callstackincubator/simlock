import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "commit-msg-check.mjs",
);

function commit(branch: string, message: string) {
  const repo = mkdtempSync(join(tmpdir(), "commit-msg-"));
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
  const file = join(repo, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  const result = spawnSync(process.execPath, [SCRIPT, file], { cwd: repo, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe("commit-msg-check.mjs", () => {
  it.each([
    ["task/968", "test: a new simulator's marks name this instance (#968)"],
    ["task/968", "feat(ios): keep simulators in Xcode's device set (#968)\n\nBody.\n"],
    ["bug/79", "# Please enter the commit message\nfix(leasing): release the hold (#79)"],
    ["bug/79-repro", "test: reproduce #79 — a released lease keeps its hold"],
    ["task/968", "Merge remote-tracking branch 'origin/feature/962-adr' into task/968"],
    ["chore/lints-b", "wip"],
  ])("accepts a commit on %s: %s", (branch, message) => {
    expect(commit(branch, message)).toEqual({ status: 0, stderr: "" });
  });

  it.each([
    ["task/968", "wip", "(#968)"],
    ["task/968", "feat: keep simulators in the device set", "(#968)"],
    ["task/968", "feature(ios): x (#968)", "<type> is feat"],
    [
      "bug/79-repro",
      "test: a released lease keeps its hold (#79)",
      "test: reproduce #79 — <claim>",
    ],
  ])("refuses a commit on %s: %s", (branch, message, shape) => {
    const result = commit(branch, message);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(shape);
  });

  it("warns when the subject names another issue, as an ADR commit in a feature's stack does", () => {
    expect(commit("task/968", "docs(adr): 0048 to Accepted (#962)")).toEqual({
      status: 0,
      stderr: "commit-msg: warning: the subject names #962, and the branch is task/968\n",
    });
  });
});

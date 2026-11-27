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
  "review-ledger.mjs",
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

describe("review-ledger.mjs", () => {
  it("posts the findings as review-metrics.mjs wrote them back: a class with words after its rule is the rule plus a detail", () => {
    const root = mkdtempSync(join(tmpdir(), "review-ledger-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    mkdirSync(origin);
    mkdirSync(work);
    mkdirSync(join(root, "config"));
    git(origin, "init", "-q", "--bare");
    git(work, "init", "-q", "-b", "main");
    git(work, "remote", "add", "origin", origin);
    git(work, "commit", "-q", "--allow-empty", "-m", "head");
    const head = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", `${head}:refs/pull/7/head`);
    const findings = join(root, "findings.json");
    const finding = (id: string, name: string) => ({
      id,
      role: "code",
      class: name,
      outcome: "fixed",
      path: "src/a.ts:1",
      round: "1",
    });
    writeFileSync(
      findings,
      JSON.stringify({
        findings: [
          finding("R1", "testing 3: error path"),
          finding("R2", "testing 3 wiring untested"),
        ],
      }),
    );

    const run = spawnSync(
      process.execPath,
      [SCRIPT, "7", "--issue", "5", "--findings", findings, "--round", `1:${head}`, "--dry-run"],
      {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, "config"), GH_REPO: "o/r" },
      },
    );

    const block = /```json\n(.*)\n```/.exec(run.stdout)?.[1] ?? "{}";
    const posted = JSON.parse(block) as { findings?: { class: string; detail?: string }[] };
    expect(posted.findings?.map((f) => [f.class, f.detail])).toEqual([
      ["testing 3", "error path"],
      ["testing 3", "wiring untested"],
    ]);
    expect(run.stdout).toContain('Classes: {"testing 3":2}.');
  });
});

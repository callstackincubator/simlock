import { execFileSync, spawnSync } from "node:child_process";
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
  "review-ledger.mjs",
);

// why: a clone whose origin holds PR #7's head, as GitHub publishes it, and a home with no
// transcripts, so the runs line is empty and the test reads this machine's sessions nowhere.
function clone() {
  const root = mkdtempSync(join(tmpdir(), "review-ledger-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const origin = join(root, "origin");
  git(root, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "a"), "1\n");
  git(origin, "add", "a");
  git(origin, "commit", "-qm", "one");
  const first = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "a"), "2\n");
  git(origin, "commit", "-qam", "two");
  const second = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/head", second);
  const dir = join(root, "clone");
  git(root, "clone", "-q", origin, dir);
  const findings = join(root, "findings.json");
  writeFileSync(
    findings,
    JSON.stringify({
      findings: [],
    }),
  );
  const ledger = (...args: string[]) => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "7", "--issue", "3", "--findings", findings, "--dry-run", ...args],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, "home"), GH_REPO: "o/r" },
      },
    );
    return { status: run.status, stderr: run.stderr, lines: run.stdout.split("\n\n")[1] };
  };
  return { first, ledger, second };
}

// why: each case builds an origin and a clone with about fifteen git processes, slow on a Windows runner.
describe("review-ledger.mjs", { timeout: 60_000 }, () => {
  it("writes each fix-check with its trigger after its commit", () => {
    const { first, ledger, second } = clone();

    const result = ledger("--round", `1:${first}`, "--round", `fix-check:ci:${second.slice(0, 9)}`);

    expect(result).toEqual({
      status: 0,
      stderr: "",
      lines: `Round 1: ${first}\nRound fix-check: ${second} ci`,
    });
  });

  it("counts each review fix-check after the first as an extension", () => {
    const { first, ledger, second } = clone();
    const capped = ["--round", `1:${first}`, "--round", `2:${first}`];
    const check = ["--round", `fix-check:review:${second}`];

    expect(ledger(...capped, ...check).lines).not.toContain("extension");
    expect(
      ledger(...capped, ...check, "--round", `fix-check:hardware:${second}`, ...check),
    ).toEqual({
      status: 0,
      stderr: "",
      lines: `Round 1: ${first}\nRound 2: ${first}\nRound fix-check: ${second} review\nRound fix-check: ${second} hardware\nRound fix-check: ${second} review\nextension: 1`,
    });
  });

  it.each([
    [
      "a fix-check with no trigger",
      ["--round", "fix-check:abcdef1"],
      "want <1|2>:<sha> or fix-check:",
    ],
    ["a trigger on round 2", ["--round", "2:ci:abcdef1"], "want <1|2>:<sha> or fix-check:"],
    ["a commit the clone lacks", ["--round", `2:${"b".repeat(40)}`], "is no commit here"],
  ])("refuses %s", (_, args, reason) => {
    const { first, ledger } = clone();

    const result = ledger("--round", `1:${first}`, ...args);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reason);
  });
});

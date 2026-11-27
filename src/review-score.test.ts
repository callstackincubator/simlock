import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", ".agents", "scripts");

const TRUTH = {
  pr: 7,
  findings: [
    {
      id: "R1",
      role: "code",
      class: "testing 3",
      outcome: "fixed",
      path: "src/a.test.ts",
      round: 1,
    },
    {
      id: "R2",
      role: "claims",
      class: "documentation 7",
      outcome: "fixed",
      path: "docs/a.md",
      round: 1,
    },
  ],
  escaped: [
    {
      bug: 31,
      fix: "f".repeat(40),
      round: "1",
      places: [
        { file: "src/seeds.ts", start: 40, end: 48 },
        { file: "src/delete.ts", start: 10, end: 12 },
      ],
    },
    {
      bug: 32,
      fix: "e".repeat(40),
      round: "1",
      places: [{ file: "src/copy.ts", start: 5, end: 9 }],
    },
    {
      bug: 33,
      fix: "d".repeat(40),
      round: "2",
      places: [{ file: "src/late.ts", start: 1, end: 3 }],
    },
  ],
};

let work: string;
let config: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

// why: the script reads its snapshot beside itself and the truth from origin, so the test gives it a checkout of its own with a local origin.
function checkout(pr: number, truth: object): void {
  const origin = join(work, "..", "origin.git");
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: origin,
    encoding: "utf8",
    input: JSON.stringify(truth),
  }).trim();
  git(origin, "update-ref", `refs/replay/${String(pr)}/truth`, blob);
  writeFileSync(
    join(work, ".agents", "replay", `${String(pr)}.json`),
    JSON.stringify({ pr, issue: null, rounds: { "1": { head: "a", base: "b", baseline: null } } }),
  );
}

function score(pr: number, findings: object[]) {
  const file = join(mkdtempSync(join(tmpdir(), "replay-findings-")), "findings.json");
  writeFileSync(file, JSON.stringify({ findings }));
  const run = spawnSync(
    process.execPath,
    [
      join(work, ".agents", "scripts", "review-score.mjs"),
      "--pr",
      String(pr),
      "--round",
      "1",
      "--findings",
      file,
      "--role",
      "code",
    ],
    { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: config } },
  );
  const rows = readFileSync(join(work, ".agents", "replay", "results.jsonl"), "utf8");
  return {
    out: run.stdout,
    row: JSON.parse(rows.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>,
  };
}

const finding = (id: string, path: string, outcome = "open") => ({
  id,
  role: "code",
  class: "seed left behind",
  outcome,
  path,
});

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "review-score-"));
  config = join(root, "config");
  work = join(root, "work");
  mkdirSync(config);
  mkdirSync(join(root, "origin.git"));
  git(join(root, "origin.git"), "init", "-q", "--bare");
  mkdirSync(join(work, ".agents", "scripts"), { recursive: true });
  mkdirSync(join(work, ".agents", "replay"));
  for (const name of [
    "review-score.mjs",
    "review-metrics.mjs",
    "transcripts.mjs",
    "cli-args.mjs",
  ]) {
    copyFileSync(join(SCRIPTS, name), join(work, ".agents", "scripts", name));
  }
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", join(root, "origin.git"));
  git(work, "commit", "-q", "--allow-empty", "-m", "start");
  checkout(7, TRUTH);
  checkout(8, { pr: 8, findings: TRUTH.findings });
});

describe("review-score.mjs", () => {
  it("counts an escaped bug as found only when a blocking finding names one of its files and a line inside the place", () => {
    const { out, row } = score(7, [
      finding("F1", "src/delete.ts:12"),
      finding("F2", "src/copy.ts:30"),
      finding("F3", "src/copy.ts"),
      finding("F4", "src/copy.ts:6", "nonblocking"),
      finding("F5", "src/a.test.ts:3"),
    ]);

    expect(out).toContain("Escaped bugs: recall 1/2.");
    expect(out).toContain("escaped #31 found by F1");
    expect(out).toContain(
      "ESCAPED #32 missed src/copy.ts:5-9; same file: F2 (other lines), F3 (no line), F4 (nonblocking) (adjudicate)",
    );
    expect(row).toMatchObject({ escapedFound: [31], escapedMissed: [32], escapedRecall: "1/2" });
  });

  it("reports recall on ledger findings apart from the escaped bugs, and a finding that found a bug is not unmatched", () => {
    const { out, row } = score(7, [
      finding("F1", "src/seeds.ts:44-60"),
      finding("F2", "copy.ts:9"),
      finding("F5", "src/a.test.ts:3"),
    ]);

    expect(out).toContain(
      "recall 1/1 defects; 0 unmatched replay findings; 0 hits on known non-defects.",
    );
    expect(out).toContain("Escaped bugs: recall 2/2.");
    expect(row).toMatchObject({ escapedRecall: "2/2", recall: "1/1", unmatched: [] });
  });

  it("prints no escaped line and writes no escaped fields for a snapshot whose truth has no escaped bugs", () => {
    const { out, row } = score(8, [finding("F5", "src/a.test.ts:3"), finding("F6", "src/b.ts:1")]);

    expect(out).toContain("recall 1/1 defects; 1 unmatched replay findings;");
    expect(out).not.toContain("Escaped");
    expect(Object.keys(row).filter((key) => key.startsWith("escaped"))).toEqual([]);
  });
});

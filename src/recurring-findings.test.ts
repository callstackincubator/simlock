import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "recurring-findings.mjs",
);

// why: the fake answers repo-scoped REST GETs only, as a cloud session's proxy does.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const github = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FILE, "utf8"));
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "-X" || args[2] !== "GET") process.exit(9);
const fields = {};
for (let i = 4; i < args.length; i += 2) fields[args[i + 1].split("=")[0]] = args[i + 1].split("=")[1];
const value = github[args[3]];
if (value === undefined) process.exit(9);
const page = Number(fields.page);
process.stdout.write(JSON.stringify(value.slice((page - 1) * 100, page * 100)));
`;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const pull = (number: number, mergedDaysAgo: number | null) => ({
  number,
  merged_at: mergedDaysAgo === null ? null : ago(mergedDaysAgo),
  updated_at: ago(mergedDaysAgo ?? 1),
});
const ledger = (...findings: object[]) => ({
  body: `## Review ledger\r\n\r\nRuns: 3.\r\n\r\n\`\`\`json\r\n${JSON.stringify({ findings })}\r\n\`\`\`\r\n`,
});
const fixed = (cls: string, path: string) => ({
  id: "R1",
  role: "code",
  class: cls,
  path,
  outcome: "fixed",
});

function recurring(github: Record<string, unknown>, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "recurring-"));
  writeFileSync(join(dir, "github.json"), JSON.stringify(github));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_GH_FILE: join(dir, "github.json"),
      GH_REPO: "o/r",
    },
  });
  return run.stdout;
}

describe("recurring-findings.mjs", () => {
  it("lists each class fixed in at least --min-prs PRs merged in the window, most PRs first, from their review ledger comments", () => {
    const out = recurring(
      {
        "repos/o/r/pulls": [pull(5, 2), pull(4, 3), pull(3, 4), pull(2, null), pull(1, 40)],
        "repos/o/r/issues/5/comments": [
          { body: "## Review notes\n- code: x" },
          ledger(fixed("Testing 2", "src/a.ts:1"), fixed("architecture 13", "docs/a.md:3")),
        ],
        "repos/o/r/issues/4/comments": [
          ledger(fixed("testing 2", "src/b.ts:2"), {
            ...fixed("architecture 13", "docs/b.md:1"),
            outcome: "incorrect",
          }),
        ],
        "repos/o/r/issues/3/comments": [ledger(fixed("testing 2", "src/c.ts:3"))],
        "repos/o/r/issues/1/comments": [ledger(fixed("architecture 13", "docs/c.md:9"))],
      },
      "--min-prs",
      "2",
    );

    expect(out).toMatch(/^Window: \S+ to \S+\. Merged PRs: 3, with a review ledger: 3\.$/m);
    expect(out.trim().split("\n").slice(1)).toEqual([
      "testing 2: 3 PRs (#5, #4, #3) src/a.ts:1, src/b.ts:2, src/c.ts:3",
    ]);
  });

  it("says so when no class recurs, and counts a PR with no ledger comment as merged but not read", () => {
    const out = recurring({
      "repos/o/r/pulls": [pull(9, 1)],
      "repos/o/r/issues/9/comments": [{ body: "LGTM" }],
    });

    expect(out).toContain("Merged PRs: 1, with a review ledger: 0.");
    expect(out).toContain("No class was fixed in 3 or more PRs.");
  });
});

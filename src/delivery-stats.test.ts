import { execFileSync } from "node:child_process";
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
  "delivery-stats.mjs",
);

const review = (lines: string): string =>
  `Closes #1\n\n## Review\n\n${lines}\n\n*Written by an agent.*\n`;

// Two weeks back from noon on 4 October: this week starts 27 Sep 12:00, the one before 20 Sep 12:00.
const input = {
  now: "2026-10-04T12:00:00Z",
  prs: [
    {
      number: 10,
      title: "this week, two rounds",
      createdAt: "2026-10-03T03:00:00Z",
      mergedAt: "2026-10-03T09:00:00Z",
      additions: 100,
      deletions: 20,
      changedFiles: 3,
      body:
        "### Status\nImplement: done  Review: round 2, 0 open\n\n" +
        review(
          [
            "Spec review: 4 findings, 1 fixed. Code review: 2 findings, 2 fixed.",
            "Rounds: 2. Tokens: 12.5M.",
            "Mutate: 12 mutants, 1 alive.",
            "",
            "Rejected:",
            "",
            "- spec: first spec claim — first reason",
            "- spec: second spec claim — second reason",
            "- code: a code claim — its reason",
            "- an untagged claim — its reason",
          ].join("\n"),
        ) +
        "\n## Notes\n\n- a list item after the Review section, not a finding\n",
    },
    {
      number: 11,
      title: "this week, nothing to fix",
      mergedAt: "2026-10-01T09:00:00Z",
      body: review("Spec review: 0 findings, 0 fixed. Code review: skipped."),
    },
    {
      number: 12,
      title: "this week, a person's PR",
      mergedAt: "2026-10-02T09:00:00Z",
      body: "Fixes a typo.",
    },
    {
      number: 15,
      title: "this week, only the code review led to a fix",
      mergedAt: "2026-10-02T10:00:00Z",
      body: review("Spec review: 2 findings, 0 fixed. Code review: 1 finding, 1 fixed."),
    },
    {
      number: 17,
      title: "this week, blocking findings and notes counted apart",
      mergedAt: "2026-10-02T12:00:00Z",
      body: review(
        [
          "Spec review: 2 blocking, 1 fixed, 3 notes. Code review: 1 blocking, 1 fixed, 1 note.",
          "",
          "Rejected:",
          "",
          "- spec: a blocking spec claim — not blocking: nothing breaks",
        ].join("\n"),
      ),
    },
    {
      number: 18,
      title: "this week, an ADR-only diff with notes",
      mergedAt: "2026-10-02T13:00:00Z",
      body: review("Spec review: 1 blocking, 0 fixed, 2 notes. Code review: skipped."),
    },
    {
      number: 19,
      title: "this week, only the claims review led to a fix",
      mergedAt: "2026-10-02T14:00:00Z",
      body: review(
        [
          "Spec review: 1 blocking, 0 fixed, 0 notes. Code review: 0 blocking, 0 fixed, 0 notes. Claims review: 3 blocking, 2 fixed, 1 note.",
          "",
          "Rejected:",
          "",
          "- claims: a stale claim — the doc is right",
        ].join("\n"),
      ),
    },
    {
      number: 22,
      title: "this week, only the comment review led to a fix",
      mergedAt: "2026-10-02T15:00:00Z",
      body: review(
        [
          "Spec review: 0 blocking, 0 fixed, 0 notes. Code review: 0 blocking, 0 fixed, 0 notes. Claims review: 0 blocking, 0 fixed, 0 notes. Comment review: 4 blocking, 3 fixed, 1 note.",
          "",
          "Rejected:",
          "",
          "- comments: a why comment — it names an upstream bug",
        ].join("\n"),
      ),
    },
    {
      number: 16,
      title: "this week, a Review heading with no counts",
      mergedAt: "2026-10-02T11:00:00Z",
      body: "## Review\n\nLooks good to me.",
    },
    {
      number: 13,
      title: "the week before",
      mergedAt: "2026-09-22T09:00:00Z",
      body: review(
        "Spec review: 1 finding, 1 fixed. Code review: 3 findings, 1 fixed.\n\nRejected:\n\n- code: last week's claim — reason",
      ),
    },
    {
      number: 14,
      title: "before the window",
      mergedAt: "2026-09-10T09:00:00Z",
      body: review("Spec review: 9 findings, 9 fixed. Code review: 9 findings, 9 fixed."),
    },
  ],
  handoffs: [
    {
      issue: 20,
      createdAt: "2026-10-02T09:00:00Z",
      body: "## Handoff\n\n### Done\n\nMost of it.\n\n### Blocked on\n\nMaintainer: amend the body.\n\n_Written by an agent._",
    },
    {
      issue: 21,
      createdAt: "2026-09-21T09:00:00Z",
      body: "## Handoff\n\n### Blocked on\n\nnothing",
    },
  ],
  needsHardware: [{ number: 30, title: "feat(ios): boot a watch" }],
};

function run(args: readonly string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), "delivery-stats-")), "input.json");
  writeFileSync(file, JSON.stringify(input));
  return execFileSync(process.execPath, [SCRIPT, "--input", file, ...args], { encoding: "utf8" });
}

/** The table row for the week starting on `day`, as its cells. */
function row(output: string, day: string): string[] {
  const line = output.split("\n").find((l) => l.startsWith(`| ${day} |`));
  if (line === undefined) throw new Error(`No row for ${day} in:\n${output}`);
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function section(output: string, heading: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) throw new Error(`No heading ${heading} in:\n${output}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("#"));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((l) => l.startsWith("- "));
}

describe("delivery-stats.mjs", () => {
  it("counts each week's merged PRs, their review findings (comment findings under claims), fixes, notes, second rounds, median hours, rounds and tokens, and handoffs", () => {
    const output = run(["--weeks", "2"]);

    expect(row(output, "2026-09-27")).toEqual([
      "2026-09-27",
      "9",
      "7",
      "2/10 (20%)",
      "4/4 (100%)",
      "5/7 (71%)",
      "8",
      "2",
      "1",
      "6.0",
      "1",
      "12.5",
      "1",
    ]);
    expect(row(output, "2026-09-20")).toEqual([
      "2026-09-20",
      "1",
      "1",
      "1/1 (100%)",
      "1/3 (33%)",
      "0/0",
      "0",
      "0",
      "0",
      "-",
      "1",
      "-",
      "1",
    ]);
    expect(output, "a PR merged before the first week counts nowhere").not.toContain("9 findings");
    expect(output.split("\n").filter((l) => /^\| \d{4}-/.test(l))).toHaveLength(2);
  });

  it("lists this week's rejected findings under the review that raised them, untagged ones apart", () => {
    const output = run(["--weeks", "2"]);

    expect(section(output, "### spec")).toEqual([
      "- #10 first spec claim — first reason",
      "- #10 second spec claim — second reason",
      "- #17 a blocking spec claim — not blocking: nothing breaks",
    ]);
    expect(section(output, "### code")).toEqual(["- #10 a code claim — its reason"]);
    expect(section(output, "### claims")).toEqual(["- #19 a stale claim — the doc is right"]);
    expect(section(output, "### comments")).toEqual([
      "- #22 a why comment — it names an upstream bug",
    ]);
    expect(section(output, "### untagged")).toEqual(["- #10 an untagged claim — its reason"]);
  });

  it("lists one row per PR merged this week with its hours, size, rounds and tokens, and their medians", () => {
    const output = run(["--weeks", "2"]);
    const rows = output.split("\n").filter((l) => l.startsWith("| #"));

    expect(rows).toContain("| #10 | 6.0 | 3 | 120 | 2 | 12.5M | this week, two rounds |");
    expect(rows).toContain("| #12 | - | - | - | - | - | this week, a person's PR |");
    expect(rows, "a PR merged the week before is not a row").not.toContainEqual(
      expect.stringContaining("| #13 |"),
    );
    expect(output).toContain("Medians: 6.0 hours, 120 lines, 1 rounds, 12.5M tokens.");
  });

  it("with --calibration, prints the last four weeks' rejected findings by review, comment ones under claims, and no table", () => {
    const output = run(["--calibration"]);

    expect(section(output, "## spec review")).toEqual([
      "- #10 first spec claim — first reason",
      "- #10 second spec claim — second reason",
      "- #17 a blocking spec claim — not blocking: nothing breaks",
    ]);
    expect(section(output, "## code review")).toEqual([
      "- #10 a code claim — its reason",
      "- #13 last week's claim — reason",
    ]);
    expect(section(output, "## claims review")).toEqual([
      "- #19 a stale claim — the doc is right",
      "- #22 a why comment — it names an upstream bug",
    ]);
    expect(output).not.toContain("| Week from |");
  });

  it("lists this week's handoffs by what they are blocked on, and the open PRs waiting on hardware", () => {
    const output = run(["--weeks", "2"]);

    expect(section(output, "## Handoffs this week")).toEqual([
      "- #20 blocked on: Maintainer: amend the body.",
    ]);
    expect(section(output, "## Open PRs waiting on hardware")).toEqual([
      "- #30 feat(ios): boot a watch",
    ]);
  });
});

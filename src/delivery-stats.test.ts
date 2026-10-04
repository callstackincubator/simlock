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
      mergedAt: "2026-10-03T09:00:00Z",
      body:
        "### Status\nImplement: done  Review: round 2, 0 open\n\n" +
        review(
          [
            "Spec review: 4 findings, 1 fixed. Code review: 2 findings, 2 fixed.",
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

/** The bullet lines under the heading that starts with `heading`, up to the next heading. */
function section(output: string, heading: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) throw new Error(`No heading ${heading} in:\n${output}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("#"));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((l) => l.startsWith("- "));
}

describe("delivery-stats.mjs", () => {
  it("counts each week's merged PRs, their review findings, fixes, notes, second rounds, alive mutants and handoffs", () => {
    const output = run(["--weeks", "2"]);

    // Week from | Merged | Reviewed | Spec review | Code review | Notes | No fix | Round 2 | Mutants alive | Handoffs
    // #16's Review heading has no counts line, so it is merged but not reviewed; #15 had a code fix.
    // #10, #11 and #15 count every finding they raised; #17 and #18 their blocking ones, and notes.
    expect(row(output, "2026-09-27")).toEqual([
      "2026-09-27",
      "7",
      "5",
      "2/9 (22%)",
      "4/4 (100%)",
      "6",
      "2",
      "1",
      "1/12",
      "1",
    ]);
    expect(row(output, "2026-09-20")).toEqual([
      "2026-09-20",
      "1",
      "1",
      "1/1 (100%)",
      "1/3 (33%)",
      "0",
      "0",
      "0",
      "0/0",
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
    expect(section(output, "### untagged")).toEqual(["- #10 an untagged claim — its reason"]);
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

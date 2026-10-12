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
  "pr-body-check.mjs",
);

const COUNTS =
  "Spec review: 1 blocking, 1 fixed, 0 notes. Code review: skipped. Claims review: 2 blocking, 1 fixed, 1 note.";
const FOOTER = "*Written by an agent.*";

function check(body: string, ...args: string[]) {
  const file = join(mkdtempSync(join(tmpdir(), "pr-body-")), "body.md");
  writeFileSync(file, body);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--body-file", file, ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "" },
    });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

const valid = [
  "Closes #12",
  "",
  "### Status",
  "Implement: done",
  "",
  "- [x] a Done when line",
  "",
  "## Assumptions",
  "",
  "- Assumption: none",
  "",
  "## Review",
  "",
  COUNTS,
  "Rounds: 1. Tokens: 3.2M.",
  "",
  "Rejected:",
  "",
  "- claims: a claim — the doc is right",
  "",
  FOOTER,
  "",
].join("\n");

describe("pr-body-check.mjs", () => {
  it("accepts a body with the counts line, a tagged Rejected line and the footer, without a word", () => {
    expect(check(valid, "--branch", "task/12")).toEqual({ status: 0, lines: [] });
  });

  it("fails a body without the footer, or whose Review section does not start with the counts line", () => {
    const result = check(`## Review\n\nLooks good.\n`);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual([
      expect.stringContaining(
        'warning: the `## Review` section has no "Rounds: <n>. Tokens: <n>M." line',
      ),
      expect.stringContaining('the last line is not "*Written by an agent.*"'),
      expect.stringContaining("does not start with the counts line"),
    ]);
  });

  it("fails on a Rejected line with no review tag, and on 'spec needs' outside a code block only", () => {
    const untagged = valid.replace("- claims: a claim", "- a claim");
    expect(check(untagged).lines).toEqual([
      expect.stringContaining("a Rejected line is not tagged"),
    ]);

    const fenced = valid.replace("Implement: done", "Implement: done\n```\nspec needs: x\n```");
    expect(check(fenced).status).toBe(0);

    const open = valid.replace("Implement: done", "Implement: done. Spec needs: a line.");
    expect(check(open).lines).toEqual([expect.stringContaining('the body says "spec needs"')]);
  });

  it("requires the Status and Assumptions sections on a <kind>/<n> branch, and on no other", () => {
    const bare = `## Review\n\n${COUNTS}\nRounds: 1. Tokens: 1.0M.\n\n${FOOTER}\n`;

    expect(check(bare, "--branch", "chore/x").status).toBe(0);
    expect(check(bare, "--branch", "bug/7").lines).toEqual([
      "pr-body: no `### Status` section",
      expect.stringContaining("no `## Assumptions` section"),
    ]);
  });

  it("warns on prose over 200 words, not counting code blocks, checklist lines or the Status, Assumptions and Review sections", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    const counted = valid.replace("Closes #12", `Closes #12\n\n${words(201)}`);
    expect(check(counted).lines).toEqual([
      expect.stringContaining("203 words outside the checklist"),
    ]);

    const uncounted = valid
      .replace("Implement: done", `Implement: done ${words(300)}`)
      .replace("- [x] a Done when line", `- [x] ${words(300)}`)
      .replace("Closes #12", "Closes #12\n\n```\n" + words(300) + "\n```");
    expect(check(uncounted).status).toBe(0);
    expect(check(uncounted).lines).toEqual([]);
  });

  it("with --draft-ok, reports every failure as a warning and exits 0", () => {
    const result = check(`## Review\n\nLooks good.\n`, "--draft-ok");

    expect(result.status).toBe(0);
    expect(result.lines).toHaveLength(3);
  });
});

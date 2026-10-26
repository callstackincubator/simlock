import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, ".agents", "scripts", "runnable.mjs");

const depends = (...numbers: number[]) =>
  `## Scope\n\nx\n\n## Depends on\n\n${numbers.map((n) => `- #${n}`).join("\n")}\n`;
const ready = (body: string, extra: object = {}) => ({ body, labels: ["task:ready"], ...extra });

function runnable(world: Record<string, unknown>) {
  const file = join(mkdtempSync(join(tmpdir(), "runnable-")), "world.json");
  writeFileSync(file, JSON.stringify(world));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "10", "--world", file], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

describe("runnable.mjs", () => {
  it("lists the open, ready, unassigned tasks whose dependencies are closed or have a ready PR, and says why each other one waits", () => {
    const result = runnable({
      10: { subIssues: [11, 12, 13, 14, 15, 16, 17] },
      11: ready(depends(), { state: "closed" }),
      12: ready(depends(11)),
      13: ready(depends(12), { prs: [{ number: 90, draft: false }] }),
      14: ready(depends(13)),
      15: ready(depends(16)),
      16: ready(depends(), { prs: [{ number: 91, draft: true }], assignees: ["agent"] }),
      17: { body: depends(), labels: ["task:draft"] },
    });

    expect(result).toEqual({
      status: 0,
      lines: [
        "chain 4 of 7 tasks",
        "waiting #13: on #12 (no PR)",
        "waiting #15: on #16 (PR in draft)",
        "waiting #16: assigned to agent",
        "waiting #17: labelled task:draft",
        "runnable: #12 #14",
      ],
    });
  });

  it("holds a task on an open issue of another feature, prints it as depends-outside, and notes a closed one", () => {
    const result = runnable({
      10: { subIssues: [11] },
      11: ready(depends(30, 31)),
      30: { state: "closed" },
      31: { parent: 40 },
    });

    expect(result).toEqual({
      status: 0,
      lines: [
        "N 11 Depends on: #30 is closed, so the line orders nothing; drop it",
        "N 11 Depends on: depends-outside #31 (open, feature #40)",
        "chain 1 of 1 tasks",
        "waiting #11: on #31 (open, outside this feature)",
        "runnable: none",
      ],
    });
  });

  it("fails on a Depends on number that does not exist and on a cycle", () => {
    const missing = runnable({ 10: { subIssues: [11] }, 11: ready(depends(99)) });
    const cycle = runnable({
      10: { subIssues: [11, 12] },
      11: ready(depends(12)),
      12: ready(depends(11)),
    });

    expect(missing.status).toBe(1);
    expect(missing.lines).toContain("B 11 Depends on: #99 does not exist; fix the line");
    expect(missing.lines.at(-1)).toBe("runnable: none");
    expect(cycle.status).toBe(1);
    expect(cycle.lines).toContain(
      "B 11 Depends on: a cycle: #11 → #12 → #11; drop one of its lines",
    );
    expect(cycle.lines.at(-1)).toBe("runnable: none");
  });
});

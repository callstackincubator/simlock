import { describe, expect, it } from "vitest";

// @ts-expect-error why: a plain script with no types
import { reviewSection } from "../.agents/scripts/review-section.mjs";

const finding = (id: string, role: string, outcome: string) => ({ id, role, outcome });

describe("review-section.mjs", () => {
  it("counts each role's findings from the findings file and writes the section the body check reads", () => {
    const section = reviewSection({
      findings: [
        finding("R1", "code", "fixed"),
        finding("R2", "code", "intentional"),
        finding("R3", "code", "duplicate"),
        finding("R4", "code", "nonblocking"),
        finding("R5", "claims", "fixed"),
      ],
      rounds: ["1", "2", "fix-check"],
      skipped: ["spec"],
      notes:
        "- code: src/a.ts:1 could be shorter\n- claims: README.md:3 vague\n- code: src/b.ts:2 name",
      rejected: "- code: src/a.ts:9 loses the lease [intentional] — ADR 0012 says so",
      tokens: "14.6",
      runs: "Runs: 19. Cost USD: 12.7457. Agent seconds: 6972.",
    });

    expect(section).toBe(
      [
        "Spec review: skipped. Code review: 2 blocking, 1 fixed, 2 notes. Claims review: 1 blocking, 1 fixed, 1 notes.",
        "Rounds: 2. Tokens: 14.6M.",
        "Runs: 19. Cost USD: 12.7457. Agent seconds: 6972.",
        "",
        "Rejected:",
        "",
        "- code: src/a.ts:9 loses the lease [intentional] — ADR 0012 says so",
        "",
        "Assessment: complete",
      ].join("\n"),
    );
  });

  it.each([
    [{ findings: [finding("R7", "spec", "open")] }, "Assessment: incomplete — R7 open"],
    [
      { findings: [], incomplete: "the code lens ran out of budget" },
      "Assessment: incomplete — the code lens ran out of budget",
    ],
  ])("reports an incomplete assessment for an open finding or a named gap", (input, last) => {
    const section = reviewSection({ rounds: ["1"], ...input });

    expect(section.split("\n").at(-1)).toBe(last);
    expect(section).toContain("Rounds: 1. Tokens: n/a.");
    expect(section).not.toContain("Rejected:");
  });

  it("refuses a rejected line with no role or no disposition tag", () => {
    expect(() =>
      reviewSection({ findings: [], rounds: ["1"], rejected: "- code: src/a.ts:9 wrong — no" }),
    ).toThrow("[incorrect|intentional|nonblocking]");
  });
});

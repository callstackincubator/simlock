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
  "report-guard.mjs",
);

const REVIEWS =
  "Spec review: 1 findings (0 blocking)  Code review: 2 findings (1 blocking)  Claims review: skipped";
const CWD = mkdtempSync(join(tmpdir(), "report-guard-"));
writeFileSync(join(CWD, "findings.json"), '{"findings": []}');
const REVIEWER = `PR: #456  Round: 2  Kind: full  Commit: abc\nAssessment: complete\nRisk: routine — x\n${REVIEWS}\nFix: none\nRerun: none\nFindings file: findings.json`;

function stop(agentType: string, lastMessage: string): string {
  return execFileSync("node", [SCRIPT], {
    input: JSON.stringify({ agent_type: agentType, last_assistant_message: lastMessage, cwd: CWD }),
    encoding: "utf8",
  });
}

describe("report-guard.mjs", () => {
  it("requires explicit review coverage but lets incomplete work stop honestly", () => {
    const report = REVIEWER.replace("Assessment: complete\n", "");
    expect(JSON.parse(stop("reviewer", report)).reason).toContain("Assessment");
    expect(
      stop(
        "reviewer",
        report
          .replace("Risk:", "Assessment: incomplete — budget exhausted\nRisk:")
          .replace("Findings file: findings.json", "Findings file:"),
      ),
    ).toBe("");
  });

  it("lets each stage agent stop once its last message holds its report block", () => {
    expect(
      stop("implementer", "```\nissue: 438  branch: task/438  pr: 456  mode: green\n```"),
    ).toBe("");
    expect(stop("reviewer", REVIEWER)).toBe("");
    expect(stop("hardware-verifier", "PR: #456  Hardware: pass\nRan: e2e/x.test.ts")).toBe("");
  });

  it("blocks a stage agent that stops with an interim message instead of its report", () => {
    const output = stop(
      "implementer",
      "Four agents are killing the mutants. I'm waiting for them.",
    );

    expect(JSON.parse(output)).toMatchObject({ decision: "block" });
    expect(JSON.parse(output).reason).toContain("report block");
  });

  it("blocks an implementer's audit report that has no audit line, and lets one with it stop", () => {
    const head =
      "issue: 472  branch: task/472  pr: 497  mode: audit  head: 9d78eb95\ntests: 49/49\n";

    expect(
      JSON.parse(stop("implementer", `${head}fixes:\n  a -> found 1 fixed 1\n`)).reason,
    ).toContain("no `audit:` line");
    expect(
      stop("implementer", `${head}audit: stale 0  replaced 0  donewhen 5/5  probed 4/4\n`),
    ).toBe("");
  });

  it("blocks an audit that probed fewer tests than it added or changed, or gives no count", () => {
    const head =
      "issue: 472  branch: task/472  pr: 497  mode: audit  head: 9d78eb95\ntests: 49/49\n";

    expect(
      JSON.parse(
        stop("implementer", `${head}audit: stale 0  replaced 0  donewhen 5/5  probed 1/4\n`),
      ).reason,
    ).toContain("probed 1 of 4");
    expect(
      JSON.parse(stop("implementer", `${head}audit: stale 0  replaced 0  donewhen 5/5\n`)).reason,
    ).toContain("no `probed` count");
    expect(
      stop("implementer", `${head}audit: stale 0  replaced 0  donewhen 5/5  probed 0/0\n`),
    ).toBe("");
  });

  it("blocks a reviewer whose block belongs to another agent, and lets any other agent stop", () => {
    expect(JSON.parse(stop("reviewer", "PR: #456  Hardware: pass"))).toMatchObject({
      decision: "block",
    });
    expect(stop("Explore", "src/a.ts:12")).toBe("");
  });

  it("blocks an implementer whose cycles fall short without remaining lines or a spec needs", () => {
    const head = "issue: 966  branch: task/966  pr: 975  mode: build  head: 9d78eb95\n";

    expect(
      JSON.parse(stop("implementer", `${head}tests: 4/9  cycles: 4/9\nremaining: none\n`)).reason,
    ).toContain("list the 5 Tests lines not built");
    expect(
      JSON.parse(stop("implementer", `${head}cycles: 7/9\nremaining:\n  a\n`)).reason,
    ).toContain("list the 2 Tests lines");
    expect(stop("implementer", `${head}cycles: 7/9\nremaining:\n  a\n  b\n`)).toBe("");
    expect(
      stop("implementer", `${head}cycles: 4/9\nremaining: none\nopen:\n  spec needs: the bound\n`),
    ).toBe("");
    expect(
      stop("implementer", `${head}Assessment: incomplete — out of context\ncycles: 4/9\n`),
    ).toBe("");
  });

  it("blocks an audit whose donewhen or covered count falls short without an open line each", () => {
    const head = "issue: 966  branch: task/966  pr: 975  mode: audit  head: 9d78eb95\ntests: 9/9\n";
    const audit = (counts: string) => `${head}audit: stale 0  replaced 0  ${counts}  probed 2/2\n`;

    expect(JSON.parse(stop("implementer", audit("donewhen 4/6"))).reason).toContain(
      "`donewhen 4/6`",
    );
    expect(
      JSON.parse(stop("implementer", `${audit("donewhen 6/6  covered 3/5")}open:\n  x\n`)).reason,
    ).toContain("`covered 3/5`");
    expect(stop("implementer", `${audit("donewhen 5/6")}open:\n  line 3: needs the lane\n`)).toBe(
      "",
    );
  });

  it.each([
    [
      "a Rerun outside its values",
      REVIEWER.replace("Rerun: none", "Rerun: maybe"),
      "`Rerun:` line",
    ],
    ["no Rerun line", REVIEWER.replace("Rerun: none\n", ""), "`Rerun:` line"],
    [
      "a lens count in another shape",
      REVIEWER.replace("1 findings (0 blocking)", "1 note"),
      "`Spec review:`",
    ],
    ["a missing lens", REVIEWER.replace("  Claims review: skipped", ""), "`Claims review:`"],
    [
      "a findings file not on disk",
      REVIEWER.replace("findings.json", "gone.json"),
      "`Findings file:`",
    ],
  ])("blocks a reviewer report with %s", (_, report, reason) => {
    expect(JSON.parse(stop("reviewer", report)).reason).toContain(reason);
  });
});

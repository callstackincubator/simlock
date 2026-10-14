import { execFileSync } from "node:child_process";
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

function stop(agentType: string, lastMessage: string): string {
  return execFileSync("node", [SCRIPT], {
    input: JSON.stringify({ agent_type: agentType, last_assistant_message: lastMessage }),
    encoding: "utf8",
  });
}

describe("report-guard.mjs", () => {
  it("lets each stage agent stop once its last message holds its report block", () => {
    expect(
      stop("implementer", "```\nissue: 438  branch: task/438  pr: 456  mode: green\n```"),
    ).toBe("");
    expect(stop("reviewer", "PR: #456  Round: 2  Kind: full  Commit: abc")).toBe("");
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
});

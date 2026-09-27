import { describe, expect, it } from "vitest";

import { REFUSED_ADB_SEQUENCES, REFUSED_ADB_VERB } from "../drivers/android/index.js";
import { REFUSED_SIMCTL_VERBS, SHUTDOWN_ALL_TARGET } from "../drivers/ios/index.js";
import { AGENT_INSTRUCTIONS } from "./index.js";

/** The one line of the instructions that lists what `simlock <tool>` refuses. */
function refusalLine(tool: "simctl" | "adb"): string {
  const lines = AGENT_INSTRUCTIONS.split("\n").filter((line) =>
    line.trim().startsWith(`- \`simlock ${tool}\` refuses `),
  );
  expect(lines, `exactly one refusal line for simlock ${tool}`).toHaveLength(1);
  return lines[0] as string;
}

describe("agent instructions", () => {
  it("name no path inside this repository", () => {
    expect(AGENT_INSTRUCTIONS).not.toMatch(/docs\//);
    expect(AGENT_INSTRUCTIONS).not.toMatch(/\.md\b/);
  });

  it("name every refused passthrough verb the drivers refuse", () => {
    // Read from the drivers' own refusal constants, so a verb a driver starts refusing fails
    // this test until the instructions tell agents about it.
    const simctl = [...REFUSED_SIMCTL_VERBS, `shutdown ${SHUTDOWN_ALL_TARGET}`];
    const adb = [
      REFUSED_ADB_VERB,
      ...REFUSED_ADB_SEQUENCES.map(({ sequence }) => sequence.join(" ")),
    ];
    expect(simctl.length).toBeGreaterThan(1);
    expect(adb.length).toBeGreaterThan(1);

    const simctlLine = refusalLine("simctl");
    for (const verb of simctl) expect(simctlLine).toContain(`\`${verb}\``);
    const adbLine = refusalLine("adb");
    for (const verb of adb) expect(adbLine).toContain(`\`${verb}\``);
  });
});

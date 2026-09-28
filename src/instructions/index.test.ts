import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { REFUSED_ADB_SEQUENCES, REFUSED_ADB_VERB } from "../drivers/android/index.js";
import {
  CALLER_SUPPLIED_SCOPE_FLAGS,
  REFUSED_RUNTIME_OPERATION,
  REFUSED_SIMCTL_VERBS,
  SHUTDOWN_ALL_TARGET,
} from "../drivers/ios/index.js";
import { AGENT_INSTRUCTIONS, renderSkill } from "./index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The one line of the instructions that lists what `simlock <tool>` refuses. */
function refusalLine(tool: "simctl" | "adb"): string {
  const lines = AGENT_INSTRUCTIONS.split("\n").filter((line) =>
    line.trim().startsWith(`- \`simlock ${tool}\` refuses `),
  );
  expect(lines, `exactly one refusal line for simlock ${tool}`).toHaveLength(1);
  return lines[0] as string;
}

describe("agent instructions", () => {
  it.each([
    ["the agent instructions name", AGENT_INSTRUCTIONS],
    ["the rendered skill names", renderSkill()],
  ])("%s no path inside this repository", (_name, text) => {
    expect(text).not.toMatch(/docs\//);
    expect(text).not.toMatch(/\.md\b/);

    // Every tracked file, and every directory holding one, as it would be written in prose.
    // Enumerated from the git index so the check covers the whole repository, not a list of
    // paths this test happened to think of.
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter((name) => name.length > 0);
    expect(files.length).toBeGreaterThan(100);
    const directories = new Set(
      files.flatMap((name) =>
        name
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => `${parts.slice(0, index + 1).join("/")}/`),
      ),
    );
    const named = [...files, ...directories].filter((path) => text.includes(path));
    expect(named).toEqual([]);
  });

  it("the rendered skill ends with the exact agent instructions, and its front matter names the skill simlock", () => {
    const skill = renderSkill();

    expect(skill.endsWith(AGENT_INSTRUCTIONS)).toBe(true);
    const header = skill.slice(0, skill.length - AGENT_INSTRUCTIONS.length);
    // Front matter, one blank line, then the instructions: nothing else around them.
    const match = /^---\n([\s\S]*?)\n---\n\n$/.exec(header);
    expect(match, `front matter then a blank line, got ${JSON.stringify(header)}`).not.toBeNull();
    const fields = (match?.[1] ?? "").split("\n");
    expect(fields).toContain("name: simlock");
    expect(fields.filter((line) => line.startsWith("description: "))).toHaveLength(1);
    expect(fields).toHaveLength(2);
  });

  it("name every refused passthrough verb the drivers refuse", () => {
    // Read from the drivers' own refusal constants, so a verb a driver starts refusing fails
    // this test until the instructions tell agents about it.
    const simctl = [
      ...REFUSED_SIMCTL_VERBS,
      `shutdown ${SHUTDOWN_ALL_TARGET}`,
      `runtime ${REFUSED_RUNTIME_OPERATION}`,
      ...[...CALLER_SUPPLIED_SCOPE_FLAGS].map((flag) => `--${flag}`),
    ];
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

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LEASE_ENDED_MESSAGE } from "../agent-device/index.js";
import { ERROR_TABLE, LEASE_LOST_EXIT_CODE } from "../contract/index.js";
import { REFUSED_ADB_SEQUENCES, REFUSED_ADB_VERB } from "../drivers/android/index.js";
import {
  CALLER_SUPPLIED_SCOPE_FLAGS,
  REFUSED_RUNTIME_OPERATION,
  REFUSED_SIMCTL_VERBS,
  SHUTDOWN_ALL_TARGET,
} from "../drivers/ios/index.js";
import { AGENT_INSTRUCTIONS, MCP_SERVER_INSTRUCTIONS, renderSkill } from "./index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const HEADINGS = [
  "## Rules for every agent",
  "## agent-device",
  "## iOS builds",
  "## simlock CLI",
  "## MCP",
] as const;

const TOOL_NAMES = ["lease_simulator", "list_devices", "release_simulator", "lease_status"];

const REQUIRED: Readonly<Record<(typeof HEADINGS)[number], readonly string[]>> = {
  "## Rules for every agent": [
    "`xcrun simctl`",
    "`adb`",
    "`avdmanager`",
    "`emulator`",
    "Claude Code",
    "Codex",
    "`SIMLOCK_AGENT_ID`",
    "`REQUESTER_ALREADY_LEASED`",
    "`--allow-download`",
    "`simlock release --all`",
    "`simlock nuke`",
    "`simlock whoami`",
  ],
  "## agent-device": [
    "`AGENT_DEVICE_DAEMON_AUTH_TOKEN`",
    "`agent-device connect proxy --daemon-base-url <url>/v1/agent-device`",
    "`--session <name>`",
    "`AGENT_DEVICE_SESSION`",
    "`agent-device open --platform <ios|android> --device <model>`",
    "`agent-device install <app> <path>`",
    "`agent-device close`",
    "`agent-device disconnect`",
    LEASE_ENDED_MESSAGE,
  ],
  "## iOS builds": [
    "`xcodebuild -destination id=<udid>`",
    "`react-native run-ios`",
    "`expo run:ios`",
    "Detox",
    "Maestro",
    "`-destination 'generic/platform=iOS Simulator'`",
    "`agent-device install`",
    "`simlock simctl install <device.address> <path-to-.app>`",
  ],
  "## simlock CLI": [
    "`simlock catalog`",
    "`simlock lease --platform <ios|android> --device <model>`",
    "`--bind-pid <pid>`",
    "`--detach`",
    "`--ttl <duration>`",
    "`simlock lease renew <lease-id>`",
    "`--physical`",
    "`simlock release <lease-id>`",
    "`lease.id`",
    "`lease.ttlDeadline`",
    "`device.address`",
    "`environment`",
    "`--export-env`",
    "`simlock simctl --lease <lease-id>`",
    "`simlock adb -s <device.address>`",
    "`simlock adb --lease <lease-id>`",
    '{"error":{"code":"...","message":"..."}}',
    "`--gateway`",
    ...[...REFUSED_SIMCTL_VERBS].map((verb) => `\`simlock simctl ${verb}\``),
    `\`simlock simctl shutdown ${SHUTDOWN_ALL_TARGET}\``,
    `\`simlock simctl runtime ${REFUSED_RUNTIME_OPERATION}\``,
    `\`simlock simctl\` refuses any option before the subcommand, ${[...CALLER_SUPPLIED_SCOPE_FLAGS].map((flag) => `\`--${flag}\``).join(" and ")} included`,
    `\`simlock adb ${REFUSED_ADB_VERB}\``,
    ...REFUSED_ADB_SEQUENCES.map(({ sequence }) => `\`simlock adb ${sequence.join(" ")}\``),
    "`simlock adb` refuses any option before the subcommand other than `-s`, `-t`, `-d` or `-e`",
    "`simlock adb shell`",
    ...[
      ERROR_TABLE.QUEUE_TIMEOUT.cliExitCode,
      ERROR_TABLE.NO_CAPACITY.cliExitCode,
      ERROR_TABLE.REQUESTER_ALREADY_LEASED.cliExitCode,
      LEASE_LOST_EXIT_CODE,
    ].map((code) => `\`${code}\``),
  ],
  "## MCP": [...TOOL_NAMES.map((name) => `\`${name}\``), "context compaction"],
};

function sectionsOf(text: string): Map<string, string> {
  const parts = text.split(/^(?=## )/m).slice(1);
  return new Map(parts.map((part) => [part.split("\n")[0] as string, part]));
}

describe("the rules text", () => {
  it("has the five sections in order, each holding its required items, and ends with the website URL", () => {
    expect(AGENT_INSTRUCTIONS.startsWith("# ")).toBe(true);
    const headings = AGENT_INSTRUCTIONS.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([...HEADINGS]);

    const sections = sectionsOf(AGENT_INSTRUCTIONS);
    for (const heading of HEADINGS) {
      const body = sections.get(heading) ?? "";
      for (const required of REQUIRED[heading]) {
        expect(body, `${heading} holds ${required}`).toContain(required);
      }
    }

    expect(sections.get("## agent-device")).not.toContain("--os");
    expect(AGENT_INSTRUCTIONS.trimEnd().split("\n").at(-1)).toBe(
      "More: https://callstackincubator.github.io/simlock/docs/",
    );
  });

  it.each([
    ["the rules text", AGENT_INSTRUCTIONS],
    ["the MCP server instructions", MCP_SERVER_INSTRUCTIONS],
    ["the router skill", renderSkill()],
  ])("%s names no path or Markdown file of this repository", (_name, text) => {
    const prose = text.replace(/https:\/\/\S+/g, "");
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter((name) => name.length > 0);
    expect(files.length).toBeGreaterThan(100);
    const topLevel = new Set(
      files.filter((name) => name.includes("/")).map((name) => name.split("/")[0]),
    );
    expect(topLevel.size).toBeGreaterThan(5);

    expect([...topLevel].filter((directory) => prose.includes(`${directory}/`))).toEqual([]);
    const markdown = prose.match(/[\w.-]+\.md\b/g) ?? [];
    expect(markdown.filter((name) => name !== "AGENTS.md" && name !== "CLAUDE.md")).toEqual([]);
  });
});

describe("the router skill", () => {
  it("opens with front matter naming the skill and saying when to use it, sends the agent to whoami and instructions, holds none of the rules, and ends with the website URL", () => {
    const skill = renderSkill();

    expect(skill.startsWith("---\nname: simlock\ndescription: ")).toBe(true);
    const frontMatter = skill.slice(4, skill.indexOf("\n---\n", 4));
    const description = frontMatter.split("\ndescription: ")[1] ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    for (const trigger of [
      "iOS simulator",
      "Android emulator",
      "test phone",
      "simctl, adb, emulator or xcodebuild",
      "agent-device",
    ]) {
      expect(description, trigger).toContain(trigger);
    }

    const body = skill.slice(skill.indexOf("\n---\n", 4) + 5);
    expect(body).toContain("`simlock whoami`");
    expect(body).toContain("`simlock instructions`");
    for (const heading of HEADINGS) expect(skill).not.toContain(heading);
    expect(skill).not.toContain("# Using Simlock");
    expect(skill).not.toContain("--allow-download");
    expect(skill.trimEnd().split("\n").at(-1)).toBe(
      "More: https://callstackincubator.github.io/simlock/docs/getting-started/connect-your-agent/",
    );
  });
});

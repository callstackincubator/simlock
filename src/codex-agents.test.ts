import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, ".agents", "scripts", "codex-agents.mjs");
const TWINS = join(ROOT, ".codex", "agents");

describe("the Codex layer in .codex/", () => {
  it("holds one committed agent twin per .claude/agents file, each current with its source", () => {
    const sources = readdirSync(join(ROOT, ".claude", "agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ".toml"))
      .sort();
    expect(readdirSync(TWINS).sort()).toEqual(sources);

    const check = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("gives a twin the source's name, description, body, mapped model and effort", () => {
    const implementer = readFileSync(join(TWINS, "implementer.toml"), "utf8");
    const source = readFileSync(join(ROOT, ".claude", "agents", "implementer.md"), "utf8");
    const description = /^description: (.*)$/m.exec(source)?.[1] ?? "";
    expect(implementer).toContain('name = "implementer"');
    expect(implementer).toContain(`description = ${JSON.stringify(description)}`);
    expect(implementer).toContain('model = "gpt-6.1-terra"');
    expect(implementer).toContain('model_reasoning_effort = "medium"');
    expect(implementer).toContain("developer_instructions = '''\n# Implement an issue");
    expect(implementer.trimEnd().endsWith("'''")).toBe(true);

    const reviewer = readFileSync(join(TWINS, "reviewer.toml"), "utf8");
    expect(reviewer).toContain('model = "gpt-6.1-sol"');
  });

  it("runs codex-hook.mjs from the current checkout on the four events the Claude hooks cover", () => {
    type Group = {
      matcher?: string;
      hooks: { command: string; timeout?: number; additionalContextLimit?: number }[];
    };
    const hooks = JSON.parse(readFileSync(join(ROOT, ".codex", "hooks.json"), "utf8"))
      .hooks as Record<string, Group[]>;
    expect(Object.keys(hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "SubagentStop",
    ]);
    for (const groups of Object.values(hooks)) {
      expect(groups).toHaveLength(1);
      const command = groups[0]?.hooks[0]?.command ?? "";
      expect(command).toContain("git rev-parse --show-toplevel");
      expect(command).toContain(".agents/scripts/codex-hook.mjs");
    }
    expect(hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(hooks.PostToolUse?.[0]?.matcher).toBe("Bash");
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.additionalContextLimit).toBe(5000);
    expect(hooks.SubagentStop?.[0]?.matcher).toBe("implementer|reviewer|hardware-verifier");
  });
});

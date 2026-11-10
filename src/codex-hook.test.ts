import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "codex-hook.mjs",
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-"));
  mkdirSync(join(root, "src/a"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Root\n");
  writeFileSync(join(root, "src/a/AGENTS.md"), "# Manual of a\n");
  writeFileSync(join(root, "rollout.jsonl"), "");
  return root;
}

// why: Codex 0.167 sends Claude Code's hook fields plus `model` and `permission_mode`; the
// fixture mirrors a recorded event so the dispatcher is tested on the real shape.
function codex(root: string, event: Record<string, unknown>) {
  const run = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({
      session_id: "s1",
      transcript_path: join(root, "rollout.jsonl"),
      cwd: root,
      model: "gpt-6.1-terra",
      permission_mode: "bypassPermissions",
      ...event,
    }),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: root, CLAUDE_BUDGET_TOKENS: "0", CLAUDE_BUDGET_HOURS: "0" },
  });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

const bash = (command: string, agent?: string) => ({
  tool_name: "Bash",
  tool_input: { command },
  ...(agent === undefined ? {} : { agent_id: agent, agent_type: "implementer" }),
});

describe("codex-hook.mjs", () => {
  it("joins the clock's and the manual hook's context into one PostToolUse answer for a Bash call", () => {
    const root = fixture();
    const run = codex(root, { hook_event_name: "PostToolUse", ...bash("cat src/a/x.ts") });

    expect(run.status).toBe(0);
    const context = JSON.parse(run.out).hookSpecificOutput.additionalContext as string;
    expect(context).toMatch(/^Local time \d\d:\d\d\./);
    expect(context).toContain("Module manual src/a/AGENTS.md:\n\n# Manual of a");
  });

  it("refuses a sub-agent's forbidden check with the tool guard's reason and exit code 2", () => {
    const run = codex(fixture(), { hook_event_name: "PreToolUse", ...bash("pnpm check", "a1") });

    expect(run.status).toBe(2);
    expect(run.err).toContain('"Checks agents never run"');
    expect(run.out).toBe("");
  });

  it("lets a Codex sub-agent run tests without the Claude Bash tool's timeout flag, which Codex has not got", () => {
    const run = codex(fixture(), {
      hook_event_name: "PreToolUse",
      ...bash("pnpm vitest run src/a.test.ts", "a1"),
    });

    expect(run.status).toBe(0);
    expect(run.err).toBe("");
  });

  it("passes the report guard's block decision through on SubagentStop", () => {
    const run = codex(fixture(), {
      hook_event_name: "SubagentStop",
      agent_id: "a1",
      agent_type: "implementer",
      last_assistant_message: "I am done, see the commits.",
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.out)).toMatchObject({ decision: "block" });
    expect(JSON.parse(run.out).reason).toContain("report block");
  });

  it("answers nothing for a tool it has no rules for and for an event it does not handle", () => {
    const root = fixture();
    const spawn = codex(root, {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_input: { message: "x" },
      agent_id: "a1",
    });
    const prompt = codex(root, { hook_event_name: "UserPromptSubmit", prompt: "hi" });

    expect([spawn.status, spawn.out, spawn.err]).toEqual([0, "", ""]);
    expect([prompt.status, prompt.out, prompt.err]).toEqual([0, "", ""]);
  });
});

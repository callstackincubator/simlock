import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "budget-guard.mjs",
);
const HOUR = 3_600_000;

/**
 * Runs the hook once for a session with an empty transcript and a one-hour time limit, from a
 * saved state of `activeMs` active time and a last tool call `sinceLastCallMs` ago. The hook
 * runs under its own `sh`, in its own process group: at its hard limit it kills its parent's
 * group, which must never be the test runner.
 */
async function call(activeMs: number, sinceLastCallMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "budget-guard-"));
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  const stateFile = join(dir, "claude-budget-s1.json");
  writeFileSync(
    stateFile,
    JSON.stringify({ activeMs, lastSeen: Date.now() - sinceLastCallMs, files: {} }),
  );
  // The trailing `exit` keeps sh from exec-ing node, so sh stays the hook's parent.
  const child = spawn("sh", ["-c", '"$0" "$1"; exit $?', process.execPath, SCRIPT], {
    detached: true,
    env: { ...process.env, TMPDIR: dir, CLAUDE_BUDGET_TOKENS: "0", CLAUDE_BUDGET_HOURS: "1" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(
    JSON.stringify({ transcript_path: transcript, session_id: "s1", tool_name: "Read" }),
  );
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { activeMs: number };
  return { status, stderr, activeMs: state.activeMs };
}

describe("budget-guard time limit", () => {
  it("counts a gap of a few seconds between tool calls as run time, and blocks the call once active time passes the limit", async () => {
    const result = await call(HOUR - 1_000, 5_000);
    expect(result.activeMs).toBeGreaterThanOrEqual(HOUR + 4_000);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Budget limit reached");
  });

  it("does not count a gap of over 30 minutes between tool calls, so a session idle overnight is not stopped", async () => {
    const result = await call(HOUR - 1_000, 8 * HOUR);
    expect(result.activeMs).toBe(HOUR - 1_000);
    expect(result.status).toBe(0);
  });
});

/** Runs the hook once for a tool call by sub-agent `agent` of a session whose sub-agent a1 has
 * used 2,000 input tokens, with a 1,000-token limit per agent and none for the session. */
async function callAsAgent(agent: string, tool: string, command?: string) {
  const dir = mkdtempSync(join(tmpdir(), "budget-guard-"));
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  mkdirSync(join(dir, "session", "subagents"), { recursive: true });
  const usage = { input_tokens: 2_000, output_tokens: 0 };
  writeFileSync(
    join(dir, "session", "subagents", "agent-a1.jsonl"),
    JSON.stringify({ message: { id: "m1", usage } }) + "\n",
  );
  writeFileSync(join(dir, "session", "subagents", "agent-a2.jsonl"), "");
  const child = spawn("sh", ["-c", '"$0" "$1"; exit $?', process.execPath, SCRIPT], {
    detached: true,
    env: {
      ...process.env,
      TMPDIR: dir,
      CLAUDE_BUDGET_TOKENS: "0",
      CLAUDE_BUDGET_HOURS: "0",
      CLAUDE_BUDGET_AGENT_TOKENS: "1000",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(
    JSON.stringify({
      transcript_path: transcript,
      session_id: "s1",
      agent_id: agent,
      tool_name: tool,
      tool_input: command === undefined ? {} : { command },
    }),
  );
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stderr };
}

describe("budget-guard agent limit", () => {
  it("blocks a tool call of the sub-agent past its own limit, and lets another sub-agent run", async () => {
    const over = await callAsAgent("a1", "Read");
    expect(over.status).toBe(2);
    expect(over.stderr).toContain("this agent used");

    expect((await callAsAgent("a2", "Read")).status).toBe(0);
  });

  it("lets the sub-agent past its limit commit and push its work", async () => {
    expect((await callAsAgent("a1", "Bash", "cd /w && git push")).status).toBe(0);
    expect((await callAsAgent("a1", "Bash", "pnpm test:changed")).status).toBe(2);
  });
});

async function callOnTranscript(lines: readonly string[], command: string, turns = "0") {
  const dir = mkdtempSync(join(tmpdir(), "budget-guard-"));
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "");
  mkdirSync(join(dir, "session", "subagents"), { recursive: true });
  writeFileSync(join(dir, "session", "subagents", "agent-a1.jsonl"), lines.join("\n") + "\n");
  const child = spawn("sh", ["-c", '"$0" "$1"; exit $?', process.execPath, SCRIPT], {
    detached: true,
    env: {
      ...process.env,
      TMPDIR: dir,
      CLAUDE_BUDGET_TOKENS: "0",
      CLAUDE_BUDGET_HOURS: "0",
      CLAUDE_BUDGET_AGENT_TOKENS: "0",
      CLAUDE_BUDGET_AGENT_TURNS: turns,
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(
    JSON.stringify({
      transcript_path: transcript,
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Bash",
      tool_input: { command },
    }),
  );
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stderr };
}

const turn = (id: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "m",
      usage: { input_tokens: 1 },
      content: [{ type: "tool_use", id: `t-${id}`, name: "Bash", input: { command } }],
    },
  });
const result = (id: string, text: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: `t-${id}`, content: text }] },
  });

describe("budget-guard turn cap and stall check", () => {
  it("blocks a sub-agent at its turn limit, counting a message split over several lines once", async () => {
    const lines = [turn("m1", "ls"), turn("m1", "ls"), result("m1", "a"), turn("m2", "pwd")];
    const under = await callOnTranscript(lines, "git status", "3");
    expect(under.status).toBe(0);

    const over = await callOnTranscript(lines, "git status", "2");
    expect(over.status).toBe(2);
    expect(over.stderr).toContain("took 2 turns of its 2");
  });

  it("blocks the same Bash command after it ran twice with the same result, and not after different results or a different command", async () => {
    const same = [turn("m1", "ls"), result("m1", "a\nb"), turn("m2", "ls"), result("m2", "a\nb")];
    const stalled = await callOnTranscript(same, "ls");
    expect(stalled.status).toBe(2);
    expect(stalled.stderr).toContain("Stall");

    expect((await callOnTranscript(same, "ls -l")).status).toBe(0);

    const differ = [turn("m1", "ls"), result("m1", "a"), turn("m2", "ls"), result("m2", "b")];
    expect((await callOnTranscript(differ, "ls")).status).toBe(0);
  });
});

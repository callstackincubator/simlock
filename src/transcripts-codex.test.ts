import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", ".agents", "scripts");

const T0 = "2026-11-08T09:38:18.000Z";
const T1 = "2026-11-08T09:40:18.000Z";

const user = (text: string, at: string) =>
  JSON.stringify({
    timestamp: at,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
const usage = (id: string, at: string, input: number, cached: number, output: number) =>
  JSON.stringify({
    timestamp: at,
    type: "token_usage_record",
    payload: {
      response_id: id,
      usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: 0,
      },
    },
  });

// why: a T3 Code thread's rollout opens with the AGENTS.md text and the environment, and puts a
// sentence before the ledger tag; the fixture mirrors a recorded one so the readers face that.
const ROLLOUT = [
  JSON.stringify({ timestamp: T0, type: "session_meta", payload: { id: "r1", cwd: "/w" } }),
  user("# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>\n# Agent guide\n</INSTRUCTIONS>", T0),
  user("<environment_context>\n  <cwd>/w</cwd>\n</environment_context>", T0),
  JSON.stringify({ timestamp: T0, type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
  user(
    "Act as the review sub-agent for this task.\nledger: pr=1446 issue=1433 stage=review round=1 role=reviewer lens=both\nissue: 1433",
    T0,
  ),
  JSON.stringify({
    timestamp: T0,
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "ls" },
  }),
  usage("resp1", T0, 30_000, 20_000, 500),
  JSON.stringify({
    timestamp: T1,
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "c1", output: "a\nb\n" },
  }),
  usage("resp1", T1, 30_000, 20_000, 500),
  usage("resp2", T1, 40_000, 40_000, 100),
  JSON.stringify({
    timestamp: T1,
    type: "response_item",
    payload: { type: "agent_message", text: "PR: #1446  Round: 1\nAssessment: complete" },
  }),
];

function codexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-sessions-"));
  mkdirSync(join(home, "sessions", "2026", "11", "08"), { recursive: true });
  writeFileSync(
    join(home, "sessions", "2026", "11", "08", "rollout-r1.jsonl"),
    `${ROLLOUT.join("\n")}\n`,
  );
  return home;
}

describe("Codex rollouts as transcripts", () => {
  it("review-metrics.mjs finds the run by the tag on the prompt's second line, counts each response once and leaves the cost unknown", () => {
    const home = codexHome();
    const empty = mkdtempSync(join(tmpdir(), "claude-config-"));
    const run = spawnSync(
      process.execPath,
      [join(SCRIPTS, "review-metrics.mjs"), "--pr", "1446", "--json"],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: empty },
      },
    );

    expect(run.status, run.stderr).toBe(0);
    const ledger = JSON.parse(run.stdout) as {
      runs: {
        role: string;
        models: string[];
        seconds: number;
        tokens: Record<string, number>;
        costUsd: number | null;
      }[];
    };
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0]).toMatchObject({
      role: "reviewer",
      models: ["gpt-6.1-sol"],
      seconds: 120,
      tokens: { input: 10_000, output: 600, cacheRead: 60_000, cacheWrite: 0 },
      costUsd: null,
    });
  });

  it("usage.mjs weighs a rollout's tokens like a transcript's and counts a turn per response", () => {
    const home = codexHome();
    const run = spawnSync(
      process.execPath,
      [join(SCRIPTS, "usage.mjs"), join(home, "sessions", "2026", "11", "08", "rollout-r1.jsonl")],
      { encoding: "utf8" },
    );

    expect(run.status, run.stderr).toBe(0);
    // why: 10,000 input ×1 + 60,000 cache read ×0.1 + 600 output ×5 is 19,000, printed as 0.0M.
    expect(run.stdout).toBe("tokens=0.0M turns=2 agents=0\n  gpt-6.1-sol 0.0M\n");
  });

  it("delivery-counters' reader sees the prompt, the shell commands and the last message of a rollout", async () => {
    const home = codexHome();
    const { runOf, tagOf } = await import(join(SCRIPTS, "transcripts.mjs"));
    const file = join(home, "sessions", "2026", "11", "08", "rollout-r1.jsonl");

    expect(tagOf(file)).toEqual({
      pr: "1446",
      issue: "1433",
      stage: "review",
      round: "1",
      role: "reviewer",
      lens: "both",
    });
    expect(runOf(file)).toMatchObject({
      prompt: expect.stringMatching(/^Act as the review sub-agent/),
      toolInputs: ["ls"],
      lastText: "PR: #1446  Round: 1\nAssessment: complete",
      startedAt: T0,
    });
  });
});

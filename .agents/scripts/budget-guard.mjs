#!/usr/bin/env node
// PreToolUse hook: stops a sub-agent, or a whole session, that has used too much or is stuck.
//
// Usage is read from the session's transcripts by usage.mjs: <session>.jsonl plus
// <session>/subagents/*.jsonl, in "input-token equivalents" (input 1, cache write 1.25, cache
// read 0.1, output 5) and in turns (assistant messages).
//
//   stall       → the same Bash command, run twice with the same result, is blocked the third
//                 time: running it again changes nothing, so the agent must do something else.
//   agent limit → a sub-agent past its token or turn limit gets every tool call blocked except
//                 `git add|commit|push` and `gh issue|pr comment`, so it can save its work and
//                 report; the rest of the session runs on.
//   soft limit  → every tool call is blocked except `gh issue|pr comment`, so the agent can post
//                 its handoff and stop.
//   hard limit  → (soft × 1.2, or run time past the limit + 30 min) the whole session process
//                 group is killed.
//
// Run time counts only active time: a gap of more than 30 minutes between two tool calls (a
// session waiting overnight for a person) is not counted.
//
// Limits come from the environment (set them in settings.local.json "env"):
//   CLAUDE_BUDGET_AGENT_TOKENS  default 15000000   (0 disables the agent token limit)
//   CLAUDE_BUDGET_AGENT_TURNS   default 300        (0 disables the agent turn limit)
//   CLAUDE_BUDGET_TOKENS        default 120000000  (0 disables the session token limit)
//   CLAUDE_BUDGET_HOURS         default 10         (0 disables the time limit)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { emptyState, scan, sessionFiles } from "./usage.mjs";

const LIMIT_AGENT_TOKENS = Number(process.env.CLAUDE_BUDGET_AGENT_TOKENS ?? 15_000_000);
const LIMIT_AGENT_TURNS = Number(process.env.CLAUDE_BUDGET_AGENT_TURNS ?? 300);
const LIMIT_TOKENS = Number(process.env.CLAUDE_BUDGET_TOKENS ?? 120_000_000);
const LIMIT_HOURS = Number(process.env.CLAUDE_BUDGET_HOURS ?? 10);
const HARD_FACTOR = 1.2;
const HARD_GRACE_MS = 30 * 60 * 1000;
const IDLE_GAP_MS = 30 * 60 * 1000;
const STALL_REPEATS = 2;

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (!input.transcript_path || !input.session_id) process.exit(0);

const { main, subDir, files } = sessionFiles(input.transcript_path);

const stateFile = path.join(os.tmpdir(), `claude-budget-${input.session_id}.json`);
let state = { activeMs: 0, lastSeen: null, files: {} };
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {}

for (const file of files) {
  const s = (state.files[file] ??= emptyState());
  for (const [key, value] of Object.entries(emptyState())) s[key] ??= value;
  scan(file, s);
}
const now = Date.now();
const gap = typeof state.lastSeen === "number" ? now - state.lastSeen : 0;
if (gap > 0 && gap <= IDLE_GAP_MS) state.activeMs = (state.activeMs ?? 0) + gap;
state.lastSeen = now;
fs.writeFileSync(stateFile, JSON.stringify(state));

const fmt = (n) => `${(n / 1e6).toFixed(1)}M`;
const cmd = input.tool_input?.command ?? "";

// why: inside a sub-agent, transcript_path can be the session's own; agent_id names the sub-agent.
const agentFile =
  typeof input.agent_id === "string"
    ? path.join(subDir, `agent-${input.agent_id.replace(/^agent-/, "")}.jsonl`)
    : input.transcript_path !== main
      ? input.transcript_path
      : null;
const me = state.files[agentFile ?? main] ?? emptyState();

if (input.tool_name === "Bash" && cmd !== "") {
  const same = me.recent.filter((r) => r.command === cmd).slice(-STALL_REPEATS);
  if (same.length === STALL_REPEATS && same.every((r) => r.hash === same[0].hash)) {
    process.stderr.write(
      `Stall: you ran this exact command ${STALL_REPEATS} times and got the same result both ` +
        `times. Running it again changes nothing. Do something else: fix the cause, wait for ` +
        `the process you started in the foreground, or stop and hand off with what you have.\n`,
    );
    process.exit(2);
  }
}

const used = Object.values(state.files).reduce((a, s) => a + s.total, 0);
const elapsedMs = state.activeMs ?? 0;
const limitMs = LIMIT_HOURS * 3600 * 1000;
const overTokens = LIMIT_TOKENS > 0 && used >= LIMIT_TOKENS;
const overTime = LIMIT_HOURS > 0 && elapsedMs >= limitMs;

if (!overTokens && !overTime) {
  if (agentFile === null) process.exit(0);
  const overAgentTokens = LIMIT_AGENT_TOKENS > 0 && me.total >= LIMIT_AGENT_TOKENS;
  const overAgentTurns = LIMIT_AGENT_TURNS > 0 && me.turns >= LIMIT_AGENT_TURNS;
  if (!overAgentTokens && !overAgentTurns) process.exit(0);
  const saving = /^\s*(?:cd \S+ && )?(?:git (?:add|commit|push)|gh (?:issue|pr) comment)\b/;
  if (input.tool_name === "Bash" && saving.test(cmd)) process.exit(0);
  const why = overAgentTokens
    ? `used ${fmt(me.total)} of its ${fmt(LIMIT_AGENT_TOKENS)} budget tokens`
    : `took ${me.turns} turns of its ${LIMIT_AGENT_TURNS}`;
  process.stderr.write(
    `Budget limit reached: this agent ${why}. Stop now. Commit and push what you have (git add, ` +
      `commit and push are still allowed), then end with your report block, with "budget" under open.\n`,
  );
  process.exit(2);
}

const why = overTokens
  ? `used ${fmt(used)} of ${fmt(LIMIT_TOKENS)} budget tokens`
  : `ran ${(elapsedMs / 3600000).toFixed(1)}h of ${LIMIT_HOURS}h active`;

const hard =
  (LIMIT_TOKENS > 0 && used >= LIMIT_TOKENS * HARD_FACTOR) ||
  (LIMIT_HOURS > 0 && elapsedMs >= limitMs + HARD_GRACE_MS);
if (hard) {
  process.stderr.write(`budget-guard: hard limit hit (${why}); killing session.\n`);
  try {
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(process.ppid)])
      .toString()
      .trim();
    if (pgid) process.kill(-Number(pgid), "SIGTERM");
  } catch {}
  process.kill(process.ppid, "SIGTERM");
  process.exit(2);
}

if (input.tool_name === "Bash" && /^\s*gh (issue|pr) comment\b/.test(cmd)) process.exit(0);
process.stderr.write(
  `Budget limit reached: this session ${why}. Stop now. ` +
    `Post a "## Handoff" comment on each issue you were working on (gh issue comment / gh pr comment ` +
    `are still allowed) saying where you stopped, then end your turn. Do not start new work.\n`,
);
process.exit(2);

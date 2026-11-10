#!/usr/bin/env node
// Codex hook dispatcher: the one command .codex/hooks.json runs for every Codex lifecycle event
// it names. Codex sends hook events in Claude Code's shape (`session_id`,
// `transcript_path`, `cwd`, `hook_event_name`, `tool_name` `Bash` with `tool_input.command`,
// `agent_id`, `agent_type`, `last_assistant_message`), so each event runs the scripts
// .claude/settings.json wires for the same event, on the same stdin:
//
//   SessionStart   checkout-age.mjs                       its text is the session's context
//   PreToolUse     budget-guard.mjs, then tool-guard.mjs   Bash only; the first refusal exits 2
//   PostToolUse    clock.mjs and manual-hook.mjs           Bash only; their contexts are joined
//   SubagentStop   report-guard.mjs                        its block decision passes through
//
// Everything else exits 0 with no output. The children run with SIMLOCK_HARNESS=codex, which
// tool-guard.mjs reads to skip its two rules about the Claude Bash tool's own flags (`timeout`,
// `run_in_background`), and budget-guard.mjs to find a sub-agent's usage in its own rollout.
// A child that fails for any reason but a refusal is reported on stderr and ignored: a bug here
// must never stop an agent. Why .codex/hooks.json reaches this file through
// `git rev-parse --show-toplevel` and checks that it exists: Codex 0.167 reads a worktree's hooks
// from the main checkout's `.codex/hooks.json`, never the worktree's own (a branch cannot add a
// hook), and every T3 Code thread runs in a worktree; the scripts that run must still be the
// checkout's own, and a checkout from before this file runs nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = {
  SessionStart: ["checkout-age.mjs"],
  PreToolUse: ["budget-guard.mjs", "tool-guard.mjs"],
  PostToolUse: ["clock.mjs", "manual-hook.mjs"],
  SubagentStop: ["report-guard.mjs"],
};
const BASH_ONLY = new Set(["PreToolUse", "PostToolUse"]);

const raw = fs.readFileSync(0, "utf8") || "{}";
let input = {};
try {
  input = JSON.parse(raw);
} catch {}
const event = input.hook_event_name;
const scripts = SCRIPTS[event] ?? [];
if (BASH_ONLY.has(event) && input.tool_name !== "Bash") process.exit(0);

const contexts = [];
for (const script of scripts) {
  const child = spawnSync(process.execPath, [path.join(HERE, script)], {
    input: raw,
    encoding: "utf8",
    env: { ...process.env, SIMLOCK_HARNESS: "codex" },
  });
  if (child.status === 2) {
    process.stderr.write(child.stderr);
    process.exit(2);
  }
  if (child.status !== 0) {
    process.stderr.write(`codex-hook: ${script} failed (${child.status}): ${child.stderr}`);
    continue;
  }
  const out = child.stdout.trim();
  if (out === "") continue;
  if (event === "SessionStart") {
    process.stdout.write(`${out}\n`);
    continue;
  }
  if (event === "SubagentStop") {
    process.stdout.write(`${out}\n`);
    process.exit(0);
  }
  try {
    const context = JSON.parse(out).hookSpecificOutput?.additionalContext;
    if (typeof context === "string" && context !== "") contexts.push(context);
  } catch {
    process.stderr.write(`codex-hook: ${script} printed something that is not JSON\n`);
  }
}
if (contexts.length > 0) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: contexts.join("\n\n") },
    }),
  );
}
process.exit(0);

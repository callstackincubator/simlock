#!/usr/bin/env node
// `node .agents/scripts/usage.mjs [<transcript.jsonl>]`: what a Claude Code session and its
// sub-agents have used so far, read from their transcripts. The default transcript is
// $CLAUDE_TRANSCRIPT_PATH, which session-env.sh exports at session start.
//
//   tokens=<n>M turns=<n> agents=<n>
//     <model> <n>M
//
// Tokens are "input-token equivalents", weighted roughly by price: input 1, cache write 1.25,
// cache read 0.1, output 5. A turn is one assistant message. budget-guard.mjs imports
// `sessionFiles(path)` (the session's transcript and its sub-agents'), `emptyState()` and
// `scan(file, state)`, which reads what the file gained since `state.offset` into it: tokens,
// turns, the model, and `recent`, the last Bash commands with a hash of what each returned.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const RECENT = 6;
const PENDING = 50;

function weighted(u) {
  return (
    (u.input_tokens ?? 0) * WEIGHTS.input +
    (u.cache_creation_input_tokens ?? 0) * WEIGHTS.cacheWrite +
    (u.cache_read_input_tokens ?? 0) * WEIGHTS.cacheRead +
    (u.output_tokens ?? 0) * WEIGHTS.output
  );
}

export function sessionFiles(transcriptPath) {
  let main = transcriptPath;
  if (path.basename(path.dirname(main)) === "subagents") {
    main = path.dirname(path.dirname(main)) + ".jsonl";
  }
  const subDir = path.join(main.replace(/\.jsonl$/, ""), "subagents");
  const files = [main];
  try {
    for (const f of fs.readdirSync(subDir))
      if (f.endsWith(".jsonl")) files.push(path.join(subDir, f));
  } catch {}
  return { main, subDir, files };
}

export function emptyState() {
  return { offset: 0, lastId: null, total: 0, turns: 0, model: null, pending: {}, recent: [] };
}

export function scan(file, s) {
  for (const line of appended(file, s).split("\n")) {
    const rec = parsed(line);
    if (rec === null) continue;
    if (rec.message?.usage || rec.type === "assistant") noteAssistant(rec, s);
    else noteResults(rec, s);
  }
  return s;
}

function appended(file, s) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return "";
  }
  if (st.size < s.offset) Object.assign(s, emptyState());
  if (st.size === s.offset) return "";
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(st.size - s.offset);
  fs.readSync(fd, buf, 0, buf.length, s.offset);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  // why: the last line may still be half-written; it is read whole on the next call.
  const whole = text.slice(0, text.lastIndexOf("\n") + 1);
  s.offset += Buffer.byteLength(whole);
  return whole;
}

function parsed(line) {
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function contentOf(rec) {
  return Array.isArray(rec.message?.content) ? rec.message.content : [];
}

function noteAssistant(rec, s) {
  notePending(rec, s);
  const u = rec.message?.usage;
  const id = rec.message?.id;
  // why: one API message is written as several lines with the same id; count it once.
  if (!u || !id || id === s.lastId) return;
  s.lastId = id;
  s.total += weighted(u);
  s.turns += 1;
  if (typeof rec.message.model === "string") s.model = rec.message.model;
}

function notePending(rec, s) {
  for (const b of contentOf(rec)) {
    if (b.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string") {
      s.pending[b.id] = b.input.command;
    }
  }
  const ids = Object.keys(s.pending);
  for (const id of ids.slice(0, Math.max(0, ids.length - PENDING))) delete s.pending[id];
}

function noteResults(rec, s) {
  for (const b of contentOf(rec)) {
    if (b.type !== "tool_result" || !(b.tool_use_id in s.pending)) continue;
    s.recent.push({ command: s.pending[b.tool_use_id], hash: hashOf(b.content) });
    delete s.pending[b.tool_use_id];
    if (s.recent.length > RECENT) s.recent.shift();
  }
}

function hashOf(content) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n")
        : JSON.stringify(content ?? "");
  return createHash("sha1").update(text.slice(0, 20_000)).digest("hex");
}

function usage(transcriptPath) {
  const agents = sessionFiles(transcriptPath).files.map((file) => scan(file, emptyState()));
  const byModel = {};
  for (const a of agents) {
    const model = a.model ?? "unknown";
    byModel[model] = (byModel[model] ?? 0) + a.total;
  }
  return {
    tokens: agents.reduce((sum, a) => sum + a.total, 0),
    turns: agents.reduce((sum, a) => sum + a.turns, 0),
    agents: agents.length - 1,
    byModel,
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const transcript = process.argv[2] ?? process.env.CLAUDE_TRANSCRIPT_PATH;
  if (!transcript) {
    console.error("usage: usage.mjs <transcript.jsonl>  (or set CLAUDE_TRANSCRIPT_PATH)");
    process.exit(64);
  }
  const u = usage(transcript);
  const m = (n) => `${(n / 1e6).toFixed(1)}M`;
  console.log(`tokens=${m(u.tokens)} turns=${u.turns} agents=${u.agents}`);
  for (const [model, n] of Object.entries(u.byModel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${model} ${m(n)}`);
  }
}

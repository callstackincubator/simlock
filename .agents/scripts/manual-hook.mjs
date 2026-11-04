#!/usr/bin/env node
// PostToolUse hook (Bash, Grep, Glob): hands an agent the module manual of every folder a tool
// call names, once per agent. Claude Code loads a folder's CLAUDE.md (and so its AGENTS.md) only
// when the Read tool opens a file there; agents read mostly through Bash (`sed -n`, `cat`, `rg`),
// so the manuals never arrived: over ten sessions up to 2026-11-04, a manual loaded for 31 of
// the 1,156 module folders sub-agents worked in.
//
// A path is a token that starts with `src/` or `ui/`, bare or after a `/` (an absolute path into
// any checkout or worktree). The manuals sent are the AGENTS.md of each folder from the top one
// down to the path's own, read from the checkout the path names: a relative path resolves
// against the call's `cwd`, which a leading `cd <dir> &&` moves. The root AGENTS.md is never
// sent: the harness loads it.
//
// Claude Code moves a hook's text over 10,000 characters to a file and shows only a preview, so
// one call's text stays under LIMIT: table padding is dropped, and a manual that does not fit
// goes in parts, at line ends, the next part with the agent's next matching call. State lives in
// $TMPDIR/claude-manuals-<session>[-<agent>].json, so each agent gets each manual once, from
// whichever checkout it read first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOPS = ["src", "ui"];
const LIMIT = 9_500;
const MORE = "\n[The rest of this manual comes with your next tool call.]";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (!input.session_id) process.exit(0);

const tool = input.tool_input ?? {};
const text = [tool.command, tool.path, tool.pattern, tool.glob]
  .filter((value) => typeof value === "string")
  .join(" ");
let cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&]+)\s*(?:&&|;)/.exec(text);
if (cd) cwd = path.resolve(cwd, cd[1].replace(/^["']|["']$/g, ""));

const found = [];
for (const token of text.split(/[\s"'`=:(),;|&<>]+/)) {
  for (const top of TOPS) {
    let at;
    if (token.startsWith(`${top}/`)) at = 0;
    else if (token.includes(`/${top}/`)) at = token.indexOf(`/${top}/`) + 1;
    else continue;
    const root = at === 0 ? cwd : path.resolve(cwd, token.slice(0, at - 1));
    const parts = token
      .slice(at)
      .split("/")
      .filter((part) => part !== "" && !/[*?[\]{}]/.test(part));
    for (let n = 1; n <= parts.length; n++) {
      const name = parts.slice(0, n).join("/");
      const file = path.join(root, name, "AGENTS.md");
      if (!found.some((m) => m.name === name) && fs.existsSync(file)) found.push({ file, name });
    }
  }
}

const key = [input.session_id, input.agent_id]
  .filter(Boolean)
  .join("-")
  .replace(/[^\w-]/g, "_");
const stateFile = path.join(os.tmpdir(), `claude-manuals-${key}.json`);
let state = { done: [], partial: [] };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
} catch {}

const queue = [
  ...state.partial,
  ...found
    .filter((m) => !state.done.includes(m.name) && !state.partial.some((p) => p.name === m.name))
    .map((m) => ({ ...m, offset: 0 })),
];
if (queue.length === 0) process.exit(0);

const pieces = [];
let used = 0;
const done = [...state.done];
const partial = [];
for (const m of queue) {
  const head = `Module manual ${m.name}/AGENTS.md${m.offset > 0 ? ", continued" : ""}:\n\n`;
  const room = LIMIT - used - head.length - MORE.length;
  if (room < 1_000) {
    partial.push(m);
    continue;
  }
  const rest = compact(fs.readFileSync(m.file, "utf8")).slice(m.offset);
  if (rest.length <= room) {
    pieces.push(head + rest);
    used += head.length + rest.length;
    done.push(m.name);
    continue;
  }
  const end = rest.lastIndexOf("\n", room);
  const cut = end > 0 ? end + 1 : room;
  pieces.push(head + rest.slice(0, cut) + MORE);
  used = LIMIT;
  partial.push({ ...m, offset: m.offset + cut });
}
fs.writeFileSync(stateFile, JSON.stringify({ done, partial }));

console.log(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: pieces.join("\n\n") },
  }),
);

function compact(manual) {
  return manual
    .split("\n")
    .map((line) =>
      line.startsWith("|") ? line.replace(/ {2,}/g, " ").replace(/-{4,}/g, "---") : line,
    )
    .join("\n");
}

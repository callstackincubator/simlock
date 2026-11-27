// For delivery-metrics.mjs: one row per Claude Code transcript, main sessions and sub-agents
// alike. `indexTranscripts(dirs, sinceMs)` reads every transcript under the project folders
// `dirs` that changed since `sinceMs`; `indexFile(file, dir)` reads one.
//
// A row holds what the run used and what it points at:
//   tag, key        the ledger tag of its prompt, and the PR or issue the prompt names
//                   (`pr:<n>`, `issue:<n>`, or `ref:<n>` for a bare #<n>)
//   usage           tokens per model, each API message once: a message is written as several
//                   lines while it streams, and the line with the most output tokens wins
//   orch            the same tokens split by the key that was current when the message came:
//                   the key of the latest sub-agent spawned or reported back, `_pre` before the
//                   first, `_pending` between a `deliver` start and its first spawn
//   turns           [start, last assistant record, key] per turn; a prompt or a notification
//                   starts a turn
//   humans          each prompt of the session, `typed` when a person wrote it
//   spawns, claims  sub-agents started, and `claim.mjs <n>` calls
//   hardware        the outcome a hardware verifier's last text reports
//   fix, mergeBase  what a fix prompt's `fixes:` list holds (CI lines, stack or merge lines,
//                   review findings R<n>, the rest), and the prompt's `merge-base:`
import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { parsed, tagOf, transcripts } from "./transcripts.mjs";

const READERS = 8;
// why: the harness and T3 Code also write user records nobody typed.
const AUTO =
  /^(\[T3 Code:|Delegated task node:|This session is being continued from a previous conversation|<local-command-|Update on pull request #|Note: the T3 server restarted|Context handoff|Caveat:)/;
const SLEPT = /The computer slept (\d+) min since the last tool call, (\d+) min this session/;
const OUTCOME = /Hardware:\s*\**\s*(pass|fail|busy|unavailable)/i;

export async function indexTranscripts(dirs, sinceMs) {
  const queue = dirs
    .flatMap((dir) => transcripts(dir).map((file) => ({ file, dir })))
    .filter(({ file }) => statSync(file).mtimeMs >= sinceMs);
  const rows = [];
  const reader = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift())
      rows.push(await indexFile(item.file, item.dir));
  };
  await Promise.all(Array.from({ length: READERS }, reader));
  return rows.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

export async function indexFile(file, dir) {
  const s = newState(file, dir);
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const record = parsed(line);
    if (record !== null && typeof record === "object") note(s, record);
  }
  return finished(s);
}

function newState(file, dir) {
  const parts = relative(dir, file).split(sep);
  const sub = parts.length > 1;
  const meta = sub ? metaOf(file) : {};
  return {
    row: {
      file,
      session: sub ? parts[0] : basename(file, ".jsonl"),
      sub,
      agentType: meta.agentType ?? null,
      toolUseId: meta.toolUseId ?? null,
      start: null,
      end: null,
      tag: tagOf(file),
      key: null,
      fix: null,
      mergeBase: null,
      usage: {},
      orch: {},
      turns: [],
      humans: [],
      spawns: [],
      claims: [],
      sleeps: [],
      hardware: null,
    },
    description: meta.description,
    messages: new Map(),
    seenTools: new Set(),
    spawnKey: new Map(),
    key: null,
    prompted: false,
    turnStart: null,
    lastAssistant: null,
    lastText: "",
  };
}

function metaOf(file) {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return {};
  }
}

function timeOf(record) {
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

function note(s, record) {
  const ts = timeOf(record);
  if (ts !== null && record.type !== "queue-operation") noteTime(s.row, ts);
  if (record.type === "user") noteUser(s, record, ts);
  else if (record.type === "assistant" && record.message) noteAssistant(s, record.message, ts);
  else if (record.type === "attachment") noteSleep(s.row, record.attachment, ts);
}

function noteTime(row, ts) {
  if (row.start === null || ts < row.start) row.start = ts;
  if (row.end === null || ts > row.end) row.end = ts;
}

function noteUser(s, record, ts) {
  const content = record.message?.content;
  if (Array.isArray(content) && content.some((b) => b.type === "tool_result")) return;
  if (record.isMeta) return;
  const text = textOf(content);
  if (record.origin?.kind === "task-notification" || text.startsWith("<task-notification>")) {
    noteNotification(s, text, ts);
  } else notePrompt(s, record, text, ts);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// why: a sub-agent that reports back makes its PR the one the orchestrator works on next.
function noteNotification(s, text, ts) {
  closeTurn(s);
  s.turnStart = ts;
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  s.key = s.spawnKey.get(id) ?? s.key;
}

function notePrompt(s, record, text, ts) {
  const row = s.row;
  if (!s.prompted) noteFirstPrompt(s, text);
  closeTurn(s);
  s.turnStart = ts;
  const command = /<command-name>\/?([\w:-]+)<\/command-name>/.exec(text)?.[1];
  if (command === "deliver" && !row.sub) s.key = "_pending";
  const typed =
    command === undefined &&
    record.promptSource !== "system" &&
    !AUTO.test(text) &&
    !text.startsWith("[Request interrupted by user");
  row.humans.push({ t: ts, key: s.key, typed });
}

function noteFirstPrompt(s, text) {
  s.prompted = true;
  s.row.key = keyOfPrompt(text, s.description);
  Object.assign(s.row, headerOf(text));
  if (s.row.sub) s.key = s.row.key;
}

function closeTurn(s) {
  if (s.turnStart !== null && s.lastAssistant !== null && s.lastAssistant >= s.turnStart) {
    s.row.turns.push([s.turnStart, s.lastAssistant, s.key]);
  }
  s.turnStart = null;
  s.lastAssistant = null;
}

function noteAssistant(s, message, ts) {
  if (ts !== null) s.lastAssistant = ts;
  s.turnStart ??= ts;
  for (const block of message.content ?? []) noteBlock(s, block, ts);
  noteUsage(s, message);
}

function noteBlock(s, block, ts) {
  if (block.type === "text" && block.text?.trim()) s.lastText = block.text.slice(-3000);
  if (block.type !== "tool_use" || s.seenTools.has(block.id)) return;
  s.seenTools.add(block.id);
  const input = block.input ?? {};
  if (block.name === "Agent" || block.name === "Task") noteSpawn(s, block.id, input);
  else if (block.name === "Skill" && input.skill === "deliver") noteDeliverSkill(s);
  else if (block.name === "Bash") noteClaim(s.row, input.command, ts);
}

function noteSpawn(s, id, input) {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const named = keyOfPrompt(prompt, input.description);
  const key = named ?? s.key;
  s.spawnKey.set(id, key);
  s.row.spawns.push({
    id,
    type: input.subagent_type ?? null,
    ledger: prompt.startsWith("ledger:"),
    key,
  });
  if (!s.row.sub && named !== null) s.key = named;
}

// why: the message that made the session start `deliver` is a command, not an intervention.
function noteDeliverSkill(s) {
  if (s.row.sub) return;
  s.key = "_pending";
  const last = s.row.humans.at(-1);
  if (last && s.row.turns.every((turn) => turn[0] < last.t)) last.typed = false;
}

function noteClaim(row, command, ts) {
  if (typeof command !== "string") return;
  const issue = /claim\.mjs["']?\s+(\d+)/.exec(command.slice(0, 300))?.[1];
  if (issue !== undefined) row.claims.push({ t: ts, issue: Number(issue) });
}

function noteUsage(s, message) {
  if (!message.usage || !message.id) return;
  const u = usageOf(message.usage);
  const seen = s.messages.get(message.id);
  if (seen === undefined) {
    s.messages.set(message.id, { model: message.model, u, bucket: s.key ?? "_pre" });
  } else if (u.out > seen.u.out) seen.u = u;
}

function usageOf(u) {
  const split = u.cache_creation;
  return {
    in: u.input_tokens ?? 0,
    out: u.output_tokens ?? 0,
    cr: u.cache_read_input_tokens ?? 0,
    cw5: split ? (split.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0),
    cw1h: split ? (split.ephemeral_1h_input_tokens ?? 0) : 0,
  };
}

// why: clock.mjs writes how long the computer slept into a main session's tool results.
function noteSleep(row, attachment, ts) {
  if (attachment?.type !== "hook_additional_context") return;
  const slept = SLEPT.exec(JSON.stringify(attachment.content ?? attachment));
  if (slept !== null) row.sleeps.push({ t: ts, min: Number(slept[1]) });
}

function finished(s) {
  closeTurn(s);
  const row = s.row;
  for (const { model, u, bucket } of s.messages.values()) {
    if (model === "<synthetic>") continue;
    addUsage(row.usage, model, u);
    addUsage((row.orch[bucket] ??= {}), model, u);
  }
  if (row.spawns.length === 0) row.orch = {};
  row.hardware = OUTCOME.exec(s.lastText)?.[1].toLowerCase() ?? null;
  return row;
}

function addUsage(target, model, u) {
  const sum = (target[model] ??= { in: 0, out: 0, cr: 0, cw5: 0, cw1h: 0 });
  for (const kind of Object.keys(sum)) sum[kind] += u[kind];
}

export function keyOfPrompt(prompt, description) {
  const text = prompt ?? "";
  const first = text.split("\n")[0].trim();
  const named = ledgerKey(first) ?? lineKey(text, "pr") ?? lineKey(text, "issue");
  if (named !== null) return named;
  const ref = /#(\d{2,5})\b/.exec(description ?? "") ?? /#(\d{2,5})\b/.exec(first);
  return ref === null ? null : `ref:${ref[1]}`;
}

function ledgerKey(first) {
  if (!first.startsWith("ledger:")) return null;
  const tag = {};
  for (const [, key, value] of first.matchAll(/(\w+)=(\S+)/g)) tag[key] = value.replace(/^#/, "");
  if (/^\d+$/.test(tag.pr ?? "")) return `pr:${tag.pr}`;
  return /^\d+$/.test(tag.issue ?? "") ? `issue:${tag.issue}` : null;
}

function lineKey(text, name) {
  const line = new RegExp(`^${name}:\\s*#?(\\d+)`, "m").exec(text);
  return line === null ? null : `${name}:${line[1]}`;
}

// why: a delivery prompt starts with `key: value` lines, and its `brief:` ends them.
function headerOf(text) {
  const cut = text.indexOf("\nbrief:");
  const head = cut === -1 ? text.slice(0, 6000) : text.slice(0, cut);
  const base = /^merge-base:[ \t]*(\S.*)$/m.exec(head);
  return { mergeBase: base === null ? null : base[1].trim().slice(0, 120), fix: fixesOf(head) };
}

function fixesOf(head) {
  const at = head.search(/^fixes:/m);
  if (at === -1) return null;
  const fix = { ci: 0, stack: 0, findings: 0, other: 0 };
  const lines = head.slice(at).split("\n");
  for (const [i, line] of lines.entries()) {
    // why: the list ends at the next unindented `key:` line of the header.
    if (i > 0 && /^[\w-]+:/.test(line)) break;
    const item = i === 0 ? line.replace(/^fixes:/, "").trim() : listItem(line);
    if (item !== "") fix[fixKind(item)] += 1;
  }
  return fix;
}

function listItem(line) {
  return /^\s*-\s+(.*)$/.exec(line)?.[1] ?? /^\s+(R\d+\b.*)$/.exec(line)?.[1] ?? "";
}

function fixKind(item) {
  if (/^ci\b/.test(item)) return "ci";
  if (/^(stack|sync|merge)\b/.test(item)) return "stack";
  return /^R\d+\b/.test(item) ? "findings" : "other";
}

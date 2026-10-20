#!/usr/bin/env node
// `node .agents/scripts/review-metrics.mjs --pr <M> [--issue <N>] [--findings <file.json>] [--json]`:
// what each agent run of a PR's delivery used, read from Claude Code's own transcripts, so no
// agent writes a number by hand.
//
// A run belongs to the PR when its prompt's first line is the ledger tag the deliver and review
// skills write, `ledger: pr=<M> issue=<N> stage=<stage> round=<round> role=<role> lens=<lens>`
// (keys in any order, any of them `-`), naming pr=<M> or, before the PR exists, issue=<N>. It
// reads every transcript under $CLAUDE_CONFIG_DIR/projects (default ~/.claude/projects),
// subagents' too, and counts each API message once (one message is written as several lines
// with the same id). Cost comes from the price table below; a model it does not list makes the
// cost unknown, never zero.
//
// --findings validates the coordinator's findings file (`{"findings": [...]}`, each with id,
// role, class, outcome, path) and adds the outcome and class counts. --json prints the ledger
// (runs, totals, findings) instead of the summary lines.
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// $ per million tokens: input, output, cache read, 5-minute cache write, 1-hour cache write.
// https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-19.
const PRICES = {
  "claude-opus-5-5": [4, 20, 0.2, 5, 8],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5, 4],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2],
};
const OUTCOMES = ["open", "fixed", "duplicate", "incorrect", "intentional", "nonblocking"];

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
const pr = option("--pr");
const issue = option("--issue");
const findingsFile = option("--findings");
if (pr === null || !/^\d+$/.test(pr) || (issue !== null && !/^\d+$/.test(issue))) {
  console.error(
    "usage: review-metrics.mjs --pr <M> [--issue <N>] [--findings <file.json>] [--json]",
  );
  process.exit(64);
}

const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const runs = transcripts(root)
  .map((file) => ({ file, tag: tagOf(file) }))
  .filter(({ tag }) => tag !== null && (tag.pr === pr || (issue !== null && tag.issue === issue)))
  .map(({ file, tag }) => run(file, tag))
  .sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""));
const findings =
  findingsFile === null ? null : checked(JSON.parse(readFileSync(findingsFile, "utf8")));

const total = (values) =>
  values.length === 0 || values.some((v) => v === null)
    ? null
    : Math.round(values.reduce((a, b) => a + b, 0) * 1e4) / 1e4;
const totals = {
  runs: runs.length,
  costUsd: total(runs.map((r) => r.costUsd)),
  seconds: total(runs.map((r) => r.seconds)),
  tokens: Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite"].map((k) => [
      k,
      total(runs.map((r) => r.tokens[k])),
    ]),
  ),
};

if (args.includes("--json")) {
  console.log(JSON.stringify({ pr: Number(pr), runs, totals, findings }, null, 2));
  process.exit(0);
}
const show = (value) => (value === null ? "unknown" : String(value));
console.log(
  `Runs: ${totals.runs}. Cost USD: ${show(totals.costUsd)}. Agent seconds: ${show(totals.seconds)}.`,
);
console.log(
  `Tokens input ${show(totals.tokens.input)}, output ${show(totals.tokens.output)}, cache read ${show(totals.tokens.cacheRead)}, cache write ${show(totals.tokens.cacheWrite)}.`,
);
for (const r of runs) {
  const where = [r.stage, r.round, r.role, r.lens].filter((v) => v !== "-").join(" ");
  console.log(`- ${where}: ${r.models.join("+")} ${show(r.seconds)} s $${show(r.costUsd)}`);
}
if (findings !== null) {
  const count = (key) =>
    JSON.stringify(
      Object.fromEntries(
        [...new Set(findings.map((f) => f[key]))]
          .sort()
          .map((v) => [v, findings.filter((f) => f[key] === v).length]),
      ),
    );
  console.log(`Finding outcomes: ${count("outcome")}. Classes: ${count("class")}.`);
}

function transcripts(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...transcripts(path));
    else if (entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

// why: transcripts run to hundreds of megabytes; the tag is in the first user record, near the top.
function tagOf(file) {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(256 * 1024);
  const read = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  for (const line of head.subarray(0, read).toString("utf8").split("\n")) {
    const rec = parsed(line);
    if (rec?.type !== "user") continue;
    const first = promptOf(rec).split("\n")[0].trim();
    if (!first.startsWith("ledger:")) return null;
    const tag = { pr: "-", issue: "-", stage: "-", round: "-", role: "-", lens: "-" };
    for (const [, key, value] of first.matchAll(/(\w+)=(\S+)/g))
      if (key in tag) tag[key] = value.replace(/^#/, "");
    return tag;
  }
  return null;
}

function run(file, tag) {
  const { messages, startedAt, finishedAt } = read(file);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Set();
  let cost = 0;
  for (const { model, usage } of messages.values()) {
    models.add(model);
    const counts = countsOf(usage);
    tokens.input += counts[0];
    tokens.output += counts[1];
    tokens.cacheRead += counts[2];
    tokens.cacheWrite += counts[3] + counts[4];
    cost = cost === null ? null : priced(model, counts, cost);
  }
  const seconds =
    startedAt === null ? null : Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
  return {
    file,
    ...tag,
    models: [...models],
    startedAt,
    finishedAt,
    seconds,
    tokens,
    costUsd: cost === null ? null : Math.round(cost * 1e4) / 1e4,
  };
}

function read(file) {
  const records = readFileSync(file, "utf8").split("\n").map(parsed).filter(Boolean);
  const stamps = records.map((r) => r.timestamp).filter((t) => typeof t === "string");
  const messages = new Map();
  for (const { message } of records.filter((r) => r.type === "assistant")) {
    if (message?.usage && message.id) messages.set(message.id, message);
  }
  return { messages, startedAt: stamps[0] ?? null, finishedAt: stamps.at(-1) ?? null };
}

// why: PRICES lists its rates in this order: input, output, cache read, 5-minute, 1-hour write.
function countsOf(usage) {
  const split = usage.cache_creation;
  return [
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
    split ? (split.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0),
    split ? (split.ephemeral_1h_input_tokens ?? 0) : 0,
  ];
}

function priced(model, counts, sofar) {
  const price = PRICES[model];
  if (price === undefined) return null;
  return sofar + counts.reduce((sum, n, i) => sum + n * price[i], 0) / 1e6;
}

function checked(file) {
  const list = file.findings;
  if (!Array.isArray(list)) throw new Error("findings must be an array");
  const ids = new Set();
  for (const f of list) {
    if (typeof f.id !== "string" || ids.has(f.id)) throw new Error("finding IDs must be unique");
    ids.add(f.id);
    checkFinding(f, list);
  }
  return list;
}

function checkFinding(f, list) {
  const missing = ["role", "class", "path"].find((k) => typeof f[k] !== "string" || f[k] === "");
  if (missing !== undefined) throw new Error(`finding ${f.id} has no ${missing}`);
  if (!OUTCOMES.includes(f.outcome)) throw new Error(`finding ${f.id} has an invalid outcome`);
  const canonical = list.some((x) => x.id === f.canonicalId && x.outcome !== "duplicate");
  if (f.outcome === "duplicate" && !canonical) {
    throw new Error(`duplicate ${f.id} must name a canonical finding`);
  }
}

function promptOf(rec) {
  const content = rec.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content.find((b) => b.type === "text")?.text ?? "") : "";
}

function parsed(line) {
  if (line === "") return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

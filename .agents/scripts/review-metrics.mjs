#!/usr/bin/env node
// `node .agents/scripts/review-metrics.mjs --pr <M> [--issue <N>] [--findings <file.json>] [--json]`:
// what each agent run of a PR's delivery used, read from Claude Code's own transcripts and
// Codex's rollouts, so no agent writes a number by hand.
//
// A run belongs to the PR when its prompt's first line is the ledger tag the deliver and review
// skills write, `ledger: pr=<M> issue=<N> stage=<stage> round=<round> role=<role> lens=<lens>`
// (keys in any order, any of them `-`), naming pr=<M> or, before the PR exists, issue=<N>. It
// reads every transcript under $CLAUDE_CONFIG_DIR/projects (default ~/.claude/projects),
// subagents' too, and every rollout under $CODEX_HOME/sessions (default ~/.codex/sessions), and
// counts each API message once (a Claude message is written as several lines with the same id;
// a Codex response is one `token_usage_record`). Cost comes from the price table below; a model
// it does not list, every Codex model today, makes the cost unknown, never zero.
//
// --replay reports the runs tagged stage=replay instead (review-replay.sh); without it they are
// left out, so a replay never counts as the PR's delivery work.
//
// --findings validates the coordinator's findings file (`{"findings": [...]}`, each with id,
// role, class, outcome, path and, when present, round) and adds the outcome and class counts. --json prints the ledger
// (runs, totals, findings) instead of the summary lines.
import { readFileSync } from "node:fs";
import { parsed, tagOf, transcriptRoots, transcripts } from "./transcripts.mjs";
import { codexUsage } from "./usage.mjs";
import { option } from "./cli-args.mjs";

// $ per million tokens: input, output, cache read, 5-minute cache write, 1-hour cache write.
// https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-19.
const PRICES = {
  "claude-opus-5-5": [4, 20, 0.2, 5, 8],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5, 4],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2],
};
const OUTCOMES = ["open", "fixed", "duplicate", "incorrect", "intentional", "nonblocking"];
const ROUNDS = ["1", "2", "fix-check"];

const args = process.argv.slice(2);
const pr = option("--pr");
const issue = option("--issue");
const findingsFile = option("--findings");
if (pr === null || !/^\d+$/.test(pr) || (issue !== null && !/^\d+$/.test(issue))) {
  console.error(
    "usage: review-metrics.mjs --pr <M> [--issue <N>] [--findings <file.json>] [--json] [--replay]",
  );
  process.exit(64);
}

const runs = transcriptRoots()
  .flatMap((root) => transcripts(root))
  .map((file) => ({ file, tag: tagOf(file) }))
  .filter(({ tag }) => tag !== null && (tag.pr === pr || (issue !== null && tag.issue === issue)))
  // why: a replay (stage=replay, review-replay.sh) re-reviews a frozen snapshot of a merged PR;
  // it must never count as that PR's delivery work. --replay reports the replays alone.
  .filter(({ tag }) => (tag.stage === "replay") === args.includes("--replay"))
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
  const s = { messages: new Map(), model: "unknown" };
  for (const r of records) noteRecord(r, s);
  return { messages: s.messages, startedAt: stamps[0] ?? null, finishedAt: stamps.at(-1) ?? null };
}

// why: a Codex token_usage_record names no model; the turn's turn_context before it does.
function noteRecord(r, s) {
  if (r.type === "assistant" && r.message?.usage && r.message.id) {
    s.messages.set(r.message.id, r.message);
  } else if (r.type === "turn_context" && typeof r.payload?.model === "string") {
    s.model = r.payload.model;
  } else if (r.type === "token_usage_record" && r.payload?.usage) {
    const id = r.payload.response_id ?? `codex-${s.messages.size}`;
    s.messages.set(id, { model: s.model, usage: codexUsage(r.payload.usage) });
  }
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
  if (f.round !== undefined && !ROUNDS.includes(String(f.round))) {
    throw new Error(`finding ${f.id} has an invalid round (1, 2 or fix-check)`);
  }
  const canonical = list.some((x) => x.id === f.canonicalId && x.outcome !== "duplicate");
  if (f.outcome === "duplicate" && !canonical) {
    throw new Error(`duplicate ${f.id} must name a canonical finding`);
  }
}

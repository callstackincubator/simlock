// For delivery-metrics.mjs: joins transcript rows (delivery-metrics-index.mjs) to merged PRs and
// builds one row per delivered PR.
//
//   delivered PR    merged, with at least one tagged build, audit, fix, review or hardware run
//   a run's PR      the PR its ledger tag names; for an issue, the PR from its `<kind>/<n>`
//                   branch or that closes it, the first one merged after the run when several do
//   orchestrator    a session with no tag that started a tagged run or a delivery agent; its
//                   tokens and turns go to the PR of the latest spawn or notification
//   wall            first `claim.mjs` call or first run, to the merge, sleep taken out
//   agent-minutes   every run's duration added up (parallel lenses add), plus orchestrator turns
//   busy wall       minutes of the wall with at least one agent present
//   review pass     one reviewer run: round 1, round 2 or fix-check
//   findings        the counts line of the PR body's `## Review` section
//   maintainer message  a prompt a person typed into the orchestrator's session
//
// `deliveredPrs({ rows, prs, clock, wanted })`: `wanted(pr)` picks the PRs to report and `clock`
// is awakeClock()'s. It returns the rows and the models `PRICES` does not list, whose tokens
// cost nothing here. `PRICES` is the one price table, with its date.
import { clipped } from "./delivery-metrics-sleep.mjs";

export const PRICES = {
  asOf: "2026-11-03",
  source: "list prices, the claude-api skill's model table",
  unit: "USD per million tokens",
  columns: ["input", "output", "cache read", "5-minute cache write", "1-hour cache write"],
  perMillion: {
    "claude-fable-5-2": [8, 40, 0.2, 10, 16],
    "claude-opus-5-5": [4, 20, 0.2, 5, 8],
    "claude-sonnet-5-5": [2, 10, 0.1, 2.5, 4],
    "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2],
    // why: the table states no cache-read price for these; a tenth of input is assumed.
    "claude-fable-5-1": [10, 50, 1, 12.5, 20],
    "claude-fable-5": [10, 50, 1, 12.5, 20],
    "claude-opus-5": [5, 25, 0.5, 6.25, 10],
    "claude-sonnet-5": [2, 10, 0.2, 2.5, 4],
  },
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const STAGES = new Set(["build", "audit", "fix", "hardware-fix", "review", "hardware"]);
const ROLES = new Set(["implementer", "reviewer", "hardware-verifier", "bug-triager"]);
const ROUNDS = { 2: "review-r2", "fix-check": "review-fc" };
const MODULE = /^(src\/[^/]+|ui|e2e|website|docs|\.agents|\.claude)\b/;
const COUNTS = /(Spec|Code|Claims|Comment) review: (\d+) (?:findings?|blocking), (\d+) fixed/g;

export function deliveredPrs({ rows, prs, clock, wanted }) {
  const join = joinOf(prs, rows);
  const unpriced = new Set();
  const list = [...attributed(rows, join)]
    .map(([number, work]) => ({ pr: join.byNumber.get(number), work }))
    .filter(({ pr, work }) => wanted(pr) && work.runs.some((run) => delivers(run.stage)))
    .map(({ pr, work }) => prRow(pr, work, { join, clock, unpriced }))
    .sort((a, b) => a.pr - b.pr);
  return { list, unpriced: [...unpriced] };
}

const delivers = (stage) => stage !== "other" && stage !== "triage";

function joinOf(prs, rows) {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const byIssue = new Map();
  const link = (issue, pr) => byIssue.set(issue, (byIssue.get(issue) ?? new Set()).add(pr));
  for (const p of prs) {
    const branch = /^(?:bug|task|feature|refactor)\/(\d+)$/.exec(p.headRefName);
    if (branch !== null) link(Number(branch[1]), p.number);
    for (const n of p.closes) link(n, p.number);
  }
  for (const { tag } of rows) {
    if (tag === null || !/^\d+$/.test(tag.issue) || !byNumber.has(Number(tag.pr))) continue;
    link(Number(tag.issue), Number(tag.pr));
  }
  return { byNumber, byIssue };
}

function resolve(join, key, t) {
  if (!key || key.startsWith("_")) return null;
  const [kind, n] = key.split(":");
  const number = Number(n);
  if (join.byNumber.has(number)) return number;
  if (kind === "pr") return null;
  const candidates = [...(join.byIssue.get(number) ?? [])].map((x) => join.byNumber.get(x));
  return candidates.length === 0 ? null : mergedNext(candidates, t).number;
}

// why: an issue with several PRs (a stack, a follow-up) is being worked on for the next to merge.
function mergedNext(candidates, t) {
  const later = candidates
    .filter((p) => Date.parse(p.mergedAt) + HOUR >= t)
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  return candidates.length === 1 ? candidates[0] : (later[0] ?? candidates.at(-1));
}

// why: `ledger: pr=1 issue=1` and stage=replay are the tests' and the replays' runs.
const isProbe = ({ tag }) =>
  tag !== null && ((tag.pr === "1" && tag.issue === "1") || tag.stage === "replay");
const isOrchestrator = (r) => r.tag === null && r.spawns.some((s) => s.ledger || ROLES.has(s.type));

function stageOf(r) {
  if (r.tag !== null && STAGES.has(r.tag.stage)) {
    return r.tag.stage === "review" ? (ROUNDS[r.tag.round] ?? "review-r1") : r.tag.stage;
  }
  return r.agentType === "bug-triager" ? "triage" : "other";
}

function attributed(rows, join) {
  const perPr = new Map();
  const workOf = (number) => {
    if (!perPr.has(number)) {
      perPr.set(number, {
        runs: [],
        orch: [],
        turns: [],
        humans: 0,
        claims: [],
        sessions: new Set(),
      });
    }
    return perPr.get(number);
  };
  const startedBy = new Map(rows.flatMap((r) => r.spawns.map((s) => [s.id, r])));
  for (const r of rows.filter((row) => !isProbe(row))) {
    if (isOrchestrator(r)) attributeOrchestrator(r, join, workOf);
    else if (r.sub) attributeRun(r, { join, workOf, startedBy });
  }
  return perPr;
}

function attributeOrchestrator(r, join, workOf) {
  const at = (key, t) => {
    const number = resolve(join, key, t);
    return number === null ? null : workOf(number);
  };
  for (const [key, usage] of Object.entries(r.orch)) {
    const work = at(key, r.start);
    work?.orch.push(usage);
    work?.sessions.add(r.session);
  }
  for (const [a, b, key] of r.turns) at(key, a)?.turns.push([a, b]);
  for (const claim of r.claims) at(`issue:${claim.issue}`, claim.t)?.claims.push(claim.t);
  if (r.sub) return;
  for (const h of r.humans.filter((human) => human.typed)) {
    const work = at(h.key, h.t);
    if (work !== null) work.humans += 1;
  }
}

function attributeRun(r, { join, workOf, startedBy }) {
  const stage = stageOf(r);
  // why: an untagged helper counts for a PR only when a delivery orchestrator started it.
  const parent = startedBy.get(r.toolUseId);
  if (stage === "other" && !(r.key && parent !== undefined && isOrchestrator(parent))) return;
  const number = resolve(join, r.key, r.start);
  if (number !== null) workOf(number).runs.push({ r, stage });
}

function prRow(pr, work, { join, clock, unpriced }) {
  const merged = Date.parse(pr.mergedAt);
  const runs = work.runs.sort((a, b) => a.r.start - b.r.start);
  const claim = Math.min(
    ...work.claims,
    ...runs.map(({ r }) => r.start),
    ...work.turns.map((t) => t[0]),
  );
  const spans = [...work.turns, ...runs.map(({ r }) => [r.start, r.end])];
  return {
    ...identityOf(pr, join),
    baseCommit: runs.map(({ r }) => r.mergeBase).find(Boolean) ?? null,
    claimAt: new Date(claim).toISOString(),
    ...wallOf(clock, spans, claim, merged),
    ...agentMinutesOf(clock, runs, work.turns),
    ...spendOf(runs, work.orch, unpriced),
    ...runCountsOf(runs),
    slow: slowLaneOf(clock, runs),
    fix: fixRunsOf(runs),
    maintainerMessages: work.humans,
    orchestratorSessions: work.sessions.size,
    findings: findingsOf(pr.body ?? ""),
  };
}

function identityOf(pr, join) {
  const lines = pr.additions + pr.deletions;
  return {
    pr: pr.number,
    title: pr.title,
    issues: [...join.byIssue].filter(([, set]) => set.has(pr.number)).map(([n]) => n),
    head: pr.headRefName,
    base: pr.baseRefName,
    mergedAt: pr.mergedAt,
    lines,
    files: pr.changedFiles,
    size: lines <= 100 ? "S" : lines <= 500 ? "M" : "L",
    modules: pr.files ? modulesOf(pr.files) : null,
  };
}

const modulesOf = (files) => [
  ...new Set(files.map((f) => MODULE.exec(f.path)?.[1]).filter(Boolean)),
];

function wallOf(clock, spans, claim, merged) {
  const wallMin = clock.awake(claim, merged) / MIN;
  const busyMin = clock.busy(spans, claim, merged) / MIN;
  const lastSeen = clipped(spans, claim, merged).at(-1)?.[1] ?? claim;
  return {
    wallMin,
    busyMin,
    noAgentMin: Math.max(0, wallMin - busyMin),
    noAgentShare: wallMin > 0 ? Math.max(0, wallMin - busyMin) / wallMin : null,
    afterLastAgentMin: clock.awake(lastSeen, merged) / MIN,
  };
}

function agentMinutesOf(clock, runs, turns) {
  const agentMin = {};
  for (const { r, stage } of runs) {
    agentMin[stage] = (agentMin[stage] ?? 0) + clock.awake(r.start, r.end) / MIN;
  }
  agentMin.orchestrator = turns.reduce((n, t) => n + clock.awake(t[0], t[1]), 0) / MIN;
  return { agentMin, agentMinTotal: total(agentMin) };
}

function spendOf(runs, orch, unpriced) {
  const usd = {};
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const add = (stage, usage) => {
    for (const [model, u] of Object.entries(usage)) {
      usd[stage] = (usd[stage] ?? 0) + costOf(model, u, unpriced);
      tokens.input += u.in;
      tokens.cacheWrite += u.cw5 + u.cw1h;
      tokens.cacheRead += u.cr;
      tokens.output += u.out;
    }
  };
  for (const { r, stage } of runs) add(stage, r.usage);
  for (const usage of orch) add("orchestrator", usage);
  return { usd, usdTotal: total(usd), tokens };
}

function costOf(model, u, unpriced) {
  const price = PRICES.perMillion[model];
  if (price === undefined) {
    unpriced.add(model);
    return 0;
  }
  const [input, output, cacheRead, write5m, write1h] = price;
  return (
    (u.in * input + u.out * output + u.cr * cacheRead + u.cw5 * write5m + u.cw1h * write1h) / 1e6
  );
}

function runCountsOf(runs) {
  const byKind = {};
  const byStage = {};
  const review = { r1: 0, r2: 0, fixCheck: 0, lensRuns: 0 };
  for (const { r, stage } of runs) {
    const kind = r.agentType ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    if (kind === "reviewer") review[passOf(r.tag)] += 1;
    else if (stage.startsWith("review")) review.lensRuns += 1;
  }
  return {
    runs: byKind,
    runsTotal: total(byKind),
    stageRuns: byStage,
    review,
    reviewPasses: review.r1 + review.r2 + review.fixCheck,
  };
}

function passOf(tag) {
  if (tag?.round === "2") return "r2";
  return tag?.round === "fix-check" ? "fixCheck" : "r1";
}

function slowLaneOf(clock, runs) {
  const slow = { starts: 0, pass: 0, fail: 0, busy: 0, unavailable: 0, unknown: 0 };
  let verifyMin = 0;
  let fixMin = 0;
  for (const { r, stage } of runs) {
    const minutes = clock.awake(r.start, r.end) / MIN;
    if (stage === "hardware-fix") fixMin += minutes;
    if (stage !== "hardware") continue;
    slow.starts += 1;
    slow[r.hardware ?? "unknown"] += 1;
    verifyMin += minutes;
  }
  return { ...slow, agentMin: verifyMin + fixMin };
}

function fixRunsOf(runs) {
  const fix = { runs: 0, ciOnly: 0, stackOnly: 0 };
  for (const { r } of runs.filter((run) => run.stage === "fix")) {
    fix.runs += 1;
    const lines = r.fix ?? { ci: 0, stack: 0, findings: 0, other: 0 };
    const nothingElse = lines.findings === 0 && lines.other === 0;
    if (lines.ci > 0 && nothingElse) fix.ciOnly += 1;
    if (lines.stack > 0 && lines.ci === 0 && nothingElse) fix.stackOnly += 1;
  }
  return fix;
}

function findingsOf(body) {
  const found = [...body.matchAll(COUNTS)];
  if (found.length === 0) return null;
  return {
    raised: found.reduce((n, m) => n + Number(m[2]), 0),
    fixed: found.reduce((n, m) => n + Number(m[3]), 0),
  };
}

const total = (object) => Object.values(object).reduce((a, b) => a + b, 0);

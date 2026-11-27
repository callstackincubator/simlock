// For delivery-metrics.mjs: the twelve headline metrics and the by-stage table, from the rows of
// delivery-metrics-prs.mjs. Each metric carries its numbers (`values`), the 95% interval of
// those that have one (`ci95`) and the line the table prints (`text`).
//
// The interval is a bootstrap over the window's PRs, seeded, so a rerun prints the same one. A
// later change inside it cannot be told from which PRs happened to land in the window.
//
// `headline(list, followUp)`: `followUp` is `bugsAfter()`'s answer, the bugs filed in the
// window's length after it against the PRs merged in it, or null when issues were not read.
// `byStage(list)` is one row per stage over the PRs that had it, largest USD first.

const RESAMPLES = 2000;
const WITHIN_MIN = 180;
const STAGE_NAMES = {
  "review-r1": "review round 1",
  "review-r2": "review round 2",
  "review-fc": "review fix-check",
  other: "other (untagged helpers)",
};

export function quantile(values, p) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const at = (v.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return v[lo] + (v[hi] - v[lo]) * (at - lo);
}
export const median = (values) => quantile(values, 0.5);
const p90 = (values) => quantile(values, 0.9);
const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => (values.length === 0 ? null : sum(values) / values.length);
const share = (list, test) => mean(list.map((p) => (test(p) ? 1 : 0)));

function round(x, digits) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  return Math.round(x * 10 ** digits) / 10 ** digits;
}

function interval(values, stat) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (v.length < 5) return null;
  const random = seeded();
  const stats = Array.from({ length: RESAMPLES }, () =>
    stat(Array.from(v, () => v[Math.floor(random() * v.length)])),
  );
  return [quantile(stats, 0.025), quantile(stats, 0.975)];
}

function seeded() {
  let seed = 0x9e3779b9;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function figure(values, stat, digits, plain = false) {
  const ci = plain ? null : interval(values, stat);
  return {
    value: round(stat(values), digits),
    ci95: ci === null ? null : ci.map((x) => round(x, digits)),
    digits,
  };
}
const plain = (value, digits) => ({ value: round(value, digits), ci95: null, digits });

const show = (x, digits) => {
  if (x === null) return "-";
  return digits === 2 ? x.toFixed(2) : String(x);
};
const tokens = (x) => {
  if (x === null) return "-";
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  return x >= 1e5 ? `${Math.round(x / 1e3)}k` : `${(x / 1e3).toFixed(1)}k`;
};

function metric(label, figures, template, as = show) {
  const text = (pick) => template.replace(/\{(\w+)\}/g, (_, name) => pick(figures[name]));
  const ranged = Object.entries(figures).filter(([, f]) => f.ci95 !== null);
  return {
    metric: label,
    text: text((f) => as(f.value, f.digits)),
    interval: ranged
      .map(([name, f]) => `${name} ${as(f.ci95[0], f.digits)}..${as(f.ci95[1], f.digits)}`)
      .join("; "),
    values: Object.fromEntries(Object.entries(figures).map(([name, f]) => [name, f.value])),
    ci95: Object.fromEntries(ranged.map(([name, f]) => [name, f.ci95])),
  };
}

export function headline(list, followUp) {
  const within = list.filter((p) => p.wallMin <= WITHIN_MIN);
  const slow = list.filter((p) => p.slow.starts > 0);
  return [
    usd(list),
    tokenUse(list),
    subAgentRuns(list),
    reviews(list),
    agentMinutes(list),
    wall(list, within),
    noAgent(list, within),
    slowLane(list, slow),
    maintainerMessages(list),
    ciOnlyFixes(list),
    bugsFiledAfter(followUp),
    orchestratorShare(list),
  ].map((m, i) => ({ n: i + 1, ...m }));
}

const sized = (list, size, field) => list.filter((p) => p.size === size).map((p) => p[field]);

function usd(list) {
  const all = list.map((p) => p.usdTotal);
  return metric(
    "USD per delivered PR, mean (median; S / M / L medians)",
    {
      mean: figure(all, mean, 2),
      median: plain(median(all), 2),
      S: figure(sized(list, "S", "usdTotal"), median, 2),
      M: figure(sized(list, "M", "usdTotal"), median, 2),
      L: figure(sized(list, "L", "usdTotal"), median, 2),
    },
    "{mean} ({median}; {S} / {M} / {L})",
  );
}

function tokenUse(list) {
  return metric(
    "Tokens per PR, median: output / cache read / fresh input",
    {
      output: figure(
        list.map((p) => p.tokens.output),
        median,
        0,
      ),
      cacheRead: figure(
        list.map((p) => p.tokens.cacheRead),
        median,
        0,
      ),
      freshInput: plain(median(list.map((p) => p.tokens.input + p.tokens.cacheWrite)), 0),
    },
    "{output} / {cacheRead} / {freshInput}",
    tokens,
  );
}

function subAgentRuns(list) {
  const runs = list.map((p) => p.runsTotal);
  return metric(
    "Sub-agent runs per PR, mean (median, p90)",
    { mean: figure(runs, mean, 1), median: plain(median(runs), 1), p90: plain(p90(runs), 1) },
    "{mean} ({median}, {p90})",
  );
}

function reviews(list) {
  const fixed = list.filter((p) => p.findings !== null).map((p) => p.findings.fixed);
  return metric(
    "Review passes per PR, mean; share with a round 2; findings fixed per PR",
    {
      passes: figure(
        list.map((p) => p.reviewPasses),
        mean,
        2,
      ),
      round2: figure(
        list.map((p) => (p.review.r2 > 0 ? 1 : 0)),
        mean,
        2,
      ),
      findingsFixed: figure(fixed, mean, 2),
    },
    "{passes}; {round2}; {findingsFixed}",
  );
}

function agentMinutes(list) {
  return metric(
    "Agent-minutes per PR, median, S / M / L",
    {
      S: figure(sized(list, "S", "agentMinTotal"), median, 1),
      M: figure(sized(list, "M", "agentMinTotal"), median, 1),
      L: figure(sized(list, "L", "agentMinTotal"), median, 1),
    },
    "{S} / {M} / {L}",
  );
}

function wall(list, within) {
  return metric(
    "Wall claim to merge: share within 3 h; median of those (median of all)",
    {
      within3h: figure(
        list.map((p) => (p.wallMin <= WITHIN_MIN ? 1 : 0)),
        mean,
        2,
      ),
      medianWithin3h: figure(
        within.map((p) => p.wallMin),
        median,
        1,
      ),
      medianAll: plain(median(list.map((p) => p.wallMin)), 1),
    },
    "{within3h}; {medianWithin3h} min ({medianAll})",
  );
}

function noAgent(list, within) {
  return metric(
    "No-agent share of wall, PRs within 3 h; last agent to merge, median",
    {
      shareWithin3h: figure(
        within.map((p) => p.noAgentShare),
        median,
        2,
      ),
      lastAgentToMergeMin: figure(
        list.map((p) => p.afterLastAgentMin),
        median,
        1,
      ),
    },
    "{shareWithin3h}; {lastAgentToMergeMin} min",
  );
}

function slowLane(list, slow) {
  return metric(
    "Slow lane: share of PRs; starts per PR; agent-min per PR; failed starts",
    {
      share: figure(
        list.map((p) => (p.slow.starts > 0 ? 1 : 0)),
        mean,
        2,
      ),
      startsPerPr: figure(
        slow.map((p) => p.slow.starts),
        mean,
        2,
      ),
      agentMinPerPr: figure(
        slow.map((p) => p.slow.agentMin),
        median,
        1,
      ),
      failed: plain(sum(list.map((p) => p.slow.fail)), 0),
      starts: plain(sum(list.map((p) => p.slow.starts)), 0),
    },
    "{share}; {startsPerPr}; {agentMinPerPr}; {failed} of {starts}",
  );
}

function maintainerMessages(list) {
  return metric(
    "Typed maintainer messages per PR, mean; share of PRs with none",
    {
      mean: figure(
        list.map((p) => p.maintainerMessages),
        mean,
        2,
      ),
      none: figure(
        list.map((p) => (p.maintainerMessages === 0 ? 1 : 0)),
        mean,
        2,
      ),
    },
    "{mean}; {none}",
  );
}

function ciOnlyFixes(list) {
  const runs = list.map((p) => p.fix.ciOnly);
  return metric(
    "CI-only fix runs per PR, mean (runs; share of PRs)",
    {
      mean: figure(runs, mean, 2),
      runs: plain(sum(runs), 0),
      share: plain(
        share(list, (p) => p.fix.ciOnly > 0),
        2,
      ),
    },
    "{mean} ({runs}; {share})",
  );
}

function bugsFiledAfter(followUp) {
  const label = "Bugs filed in the window's length after it, per merged PR (naming a delivered PR)";
  if (followUp === null || !followUp.complete) {
    const text = followUp === null ? "not read" : `readable ${followUp.readableOn}`;
    return { metric: label, text, interval: "", values: {}, ci95: {} };
  }
  return metric(
    label,
    {
      perMergedPr: plain(followUp.bugs / Math.max(1, followUp.mergedPrs), 2),
      bugs: plain(followUp.bugs, 0),
      mergedPrs: plain(followUp.mergedPrs, 0),
      naming: plain(followUp.naming, 0),
    },
    "{perMergedPr} = {bugs} / {mergedPrs} ({naming})",
  );
}

function orchestratorShare(list) {
  const of = (p) => (p.usd.orchestrator ?? 0) / Math.max(1e-9, p.usdTotal);
  const pooled =
    sum(list.map((p) => p.usd.orchestrator ?? 0)) /
    Math.max(1e-9, sum(list.map((p) => p.usdTotal)));
  return metric(
    "Orchestrator share of a PR's USD, median (pooled)",
    { median: figure(list.map(of), median, 2), pooled: plain(pooled, 2) },
    "{median} ({pooled})",
  );
}

export function bugsAfter({ window, prs, issues, delivered, now }) {
  const to = window.to + (window.to - window.from);
  const inWindow = (iso, a, b) => Date.parse(iso) >= a && Date.parse(iso) < b;
  const bugs = issues.filter(
    (i) => inWindow(i.createdAt, window.to, to) && i.labels.some((l) => l.startsWith("bug:")),
  );
  const refs = new Set(delivered.flatMap((p) => [p.pr, ...p.issues]));
  const names = (i) =>
    [...(i.body ?? "").matchAll(/#(\d+)\b/g)].some((m) => refs.has(Number(m[1])));
  return {
    complete: to <= now,
    readableOn: new Date(to).toISOString().slice(0, 10),
    mergedPrs: prs.filter((p) => inWindow(p.mergedAt, window.from, window.to)).length,
    bugs: bugs.length,
    naming: bugs.filter(names).length,
  };
}

export function byStage(list) {
  const all = Math.round(sum(list.map((p) => p.usdTotal)));
  const stages = [
    ...new Set(list.flatMap((p) => [...Object.keys(p.usd), ...Object.keys(p.agentMin)])),
  ];
  return stages
    .map((stage) => stageRow(stage, list, all))
    .filter((row) => row.prs > 0)
    .sort((a, b) => b.usd.sum - a.usd.sum || a.stage.localeCompare(b.stage));
}

function stageRow(stage, list, all) {
  const having = list.filter((p) => (p.usd[stage] ?? 0) > 0 || (p.agentMin[stage] ?? 0) > 0);
  const minutes = having.map((p) => p.agentMin[stage] ?? 0);
  const spent = having.map((p) => p.usd[stage] ?? 0);
  const usdSum = round(sum(spent), 0);
  return {
    stage: STAGE_NAMES[stage] ?? stage,
    prs: having.length,
    runsPerPr:
      stage === "orchestrator" ? null : round(mean(having.map((p) => p.stageRuns[stage] ?? 0)), 2),
    agentMin: { median: round(median(minutes), 1), p90: round(p90(minutes), 1) },
    usd: { median: round(median(spent), 2), p90: round(p90(spent), 2), sum: usdSum },
    share: round(usdSum / Math.max(1, all), 2),
  };
}

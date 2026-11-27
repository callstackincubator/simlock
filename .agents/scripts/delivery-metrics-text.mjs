// For delivery-metrics.mjs: its report as Markdown tables. `reportText(report)` takes what
// `--json` prints; `roundedRow(row)` rounds a PR row's minutes and USD for both outputs.

export function reportText(report) {
  const lines = report.prs === undefined ? windowText(report) : prText(report.prs);
  lines.push("", `USD at list prices as of ${report.prices.asOf}.`);
  if (report.unpricedModels.length > 0) {
    lines.push(
      `No price for ${report.unpricedModels.join(", ")}: their tokens count as $0. Add them to PRICES.`,
    );
  }
  lines.push(
    report.sleepRecordedFrom === null
      ? "Sleep is estimated from the clock hook's lines; no pmset record was read."
      : `Sleep is recorded from ${report.sleepRecordedFrom.slice(0, 10)} and estimated from the clock hook's lines before.`,
  );
  return lines.join("\n");
}

export function roundedRow(row) {
  const each = (object, digits) =>
    Object.fromEntries(Object.entries(object).map(([name, v]) => [name, round(v, digits)]));
  return {
    ...row,
    wallMin: round(row.wallMin, 1),
    busyMin: round(row.busyMin, 1),
    noAgentMin: round(row.noAgentMin, 1),
    noAgentShare: round(row.noAgentShare ?? 0, 2),
    afterLastAgentMin: round(row.afterLastAgentMin, 1),
    agentMin: each(row.agentMin, 1),
    agentMinTotal: round(row.agentMinTotal, 1),
    usd: each(row.usd, 2),
    usdTotal: round(row.usdTotal, 2),
    slow: { ...row.slow, agentMin: round(row.slow.agentMin, 1) },
  };
}

function round(x, digits) {
  return Math.round(x * 10 ** digits) / 10 ** digits;
}

function tableRow(cells) {
  return `| ${cells.map((cell) => cell ?? "-").join(" | ")} |`;
}

function listed(object, show = String) {
  const items = Object.entries(object).map(([name, v]) => `${name} ${show(v)}`);
  return items.length === 0 ? "-" : items.join(", ");
}

function windowText(report) {
  const { window, headline, byStage, autonomy } = report;
  return [
    `# Delivery metrics, ${window.from.slice(0, 10)}..${window.to.slice(0, 10)}: ${report.deliveredPrs} delivered PRs`,
    "",
    "| # | metric | value | 95% interval |",
    "| --: | --- | --- | --- |",
    ...headline.map((m) => tableRow([m.n, m.metric, m.text, m.interval || "-"])),
    "",
    "## By stage, over the PRs that had the stage",
    "",
    "| stage | PRs with it | runs per PR | agent-min median / p90 | USD median / p90 | USD sum | share |",
    "| --- | --: | --: | --: | --: | --: | --: |",
    ...byStage.map(stageLine),
    ...(autonomy === null ? [] : autonomyText(autonomy)),
  ];
}

function stageLine(s) {
  return tableRow([
    s.stage,
    s.prs,
    s.runsPerPr,
    `${s.agentMin.median} / ${s.agentMin.p90}`,
    `${s.usd.median.toFixed(2)} / ${s.usd.p90.toFixed(2)}`,
    s.usd.sum,
    s.share.toFixed(2),
  ]);
}

function autonomyText(a) {
  const hours = (h) => `${h.median ?? "-"} (p90 ${h.p90 ?? "-"}; ${h.prs} PRs)`;
  const named = {};
  for (const n of a.followUpBugs.flatMap((f) => f.prs)) named[`#${n}`] = (named[`#${n}`] ?? 0) + 1;
  return [
    "",
    "## Autonomy",
    "",
    "| what | value |",
    "| --- | --- |",
    tableRow([
      "PRs merged with `fast-track`",
      `${a.fastTrackMerged.length} of ${a.mergedPrs} merged`,
    ]),
    tableRow([
      "Bugs held at the fast-track entry, by `no` line",
      `${a.heldAtEntry.bugs}: ${listed(a.heldAtEntry.byLine)}`,
    ]),
    tableRow([
      "PRs held at the fast-track exit, by reason",
      `${a.heldAtExit.issues}: ${listed(a.heldAtExit.byReason)}`,
    ]),
    tableRow(["Handoffs", a.handoffs]),
    tableRow([
      "Follow-up bugs, and how many name each PR merged in the 28 days before",
      `${a.followUpBugs.length}: ${listed(named)}`,
    ]),
    tableRow(['Issues and PRs with a "pending the maintainer" mark, today', a.pendingDecisions]),
    tableRow(["Hours from bug report to `main`, median: all bug PRs", hours(a.bugHoursToMain.all)]),
    tableRow([
      "Hours from bug report to `main`, median: fast-tracked",
      hours(a.bugHoursToMain.fastTrack),
    ]),
  ];
}

function prText(prs) {
  return [
    "| PR | issue | lines / modules | base commit | wall min | agent-min by stage | USD by stage | tokens: input / cache write / cache read / output | runs by kind | review passes | slow-lane starts | fix runs | maintainer messages |",
    "| --- | --- | --: | --- | --: | --- | --- | --- | --- | --: | --- | --: | --: |",
    ...prs.map(prLine),
  ];
}

function prLine(p) {
  const tokens = [p.tokens.input, p.tokens.cacheWrite, p.tokens.cacheRead, p.tokens.output];
  return tableRow([
    `#${p.pr}`,
    p.issues.map((n) => `#${n}`).join(" ") || "-",
    `${p.lines} / ${p.modules?.length ?? "-"}`,
    p.baseCommit?.slice(0, 9),
    p.wallMin,
    `${p.agentMinTotal} (${listed(p.agentMin)})`,
    `${p.usdTotal.toFixed(2)} (${listed(p.usd, (v) => v.toFixed(2))})`,
    tokens.map(compact).join(" / "),
    `${p.runsTotal} (${listed(p.runs)})`,
    p.reviewPasses,
    slowLaneCell(p.slow),
    p.fix.runs,
    p.maintainerMessages,
  ]);
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(1)}k`);

function slowLaneCell({ starts, agentMin, ...byOutcome }) {
  if (starts === 0) return "0";
  const seen = Object.fromEntries(Object.entries(byOutcome).filter(([, n]) => n > 0));
  return `${starts} (${listed(seen)}; ${agentMin} agent-min with fixes)`;
}

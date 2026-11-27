// For delivery-metrics.mjs: how much of a window's work went through without the maintainer.
//
//   fastTrackMerged   PRs merged in the window that close an issue carrying `fast-track`
//   heldAtEntry       bugs whose newest triage report of the window says `no` on a Fast track
//                     line, by line
//   heldAtExit        issues with a `## Handoff` of the window that quotes the fast-track exit
//                     check's line (`fast-track: #<n> held: PR #<m> ...; PR #<m> ...`, with or
//                     without `#<n> held:`), by the holds that line lists; the newest such
//                     handoff of an issue counts
//   handoffs          every `## Handoff` comment of the window
//   followUpBugs      bugs filed in the window whose body, or whose triage report's Root cause,
//                     names a PR merged in the 28 days before the bug was filed (by number, by
//                     an issue it closed, or by its merge commit): candidates to read, not a verdict
//   pendingDecisions  issues and PRs that carry a "pending the maintainer" mark today
//   bugHoursToMain    hours from a bug's filing to the merge of its `bug/<n>` PR, for the PRs
//                     merged in the window
import { fastTrackFacts } from "./body-rules.mjs";
import { median, quantile } from "./delivery-metrics-stats.mjs";

const DAY = 24 * 60 * 60 * 1000;
const FOLLOW_UP_DAYS = 28;
// why: a handoff's prose names lines, files, paths and decisions too; only the line the exit
// check printed says why it held, one `PR #<m> ...` part per hold (fast-track.mjs, exitCheck).
const HELD_LINE = /fast-track:[ \t]*(?:#\d+ held:[ \t]*)?(PR #\d+ [^\n]*)/;
const EXIT_HOLDS = [
  [/^PR #\d+ changes \d+ lines, over \d+/, "lines over the limit"],
  [/^PR #\d+ changes \d+ files, over \d+/, "files over the limit"],
  [/^PR #\d+ has a "Decision taken" comment/, "a Decision taken comment"],
  [/^PR #\d+ touches \S/, "a surface path"],
];

export function autonomy({ window, prs, issues, comments, pendingDecisions }) {
  const inside = (iso) => Date.parse(iso) >= window.from && Date.parse(iso) < window.to;
  const issueOf = new Map(issues.map((i) => [i.number, i]));
  const merged = prs.filter((p) => inside(p.mergedAt));
  const written = comments
    .filter((c) => inside(c.createdAt))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const handoffs = written.filter((c) => c.body.startsWith("## Handoff"));
  const bugs = issues.filter(
    (i) => inside(i.createdAt) && i.labels.some((l) => l.startsWith("bug:")),
  );
  return {
    mergedPrs: merged.length,
    fastTrackMerged: merged.filter((p) => fastTracked(p, issueOf)).map((p) => p.number),
    heldAtEntry: heldAtEntry(written),
    heldAtExit: heldAtExit(handoffs),
    handoffs: handoffs.length,
    followUpBugs: bugs.map((bug) => followUp(bug, prs, comments)).filter((f) => f.prs.length > 0),
    pendingDecisions,
    bugHoursToMain: bugHoursToMain(merged, issueOf),
  };
}

const bugOf = (pr) => Number(/^bug\/(\d+)$/.exec(pr.headRefName)?.[1]);
const fastTracked = (pr, issueOf) =>
  [bugOf(pr), ...pr.closes].some((n) => issueOf.get(n)?.labels.includes("fast-track"));

function heldAtEntry(comments) {
  const newest = new Map();
  for (const c of comments) if (fastTrackFacts(c.body) !== null) newest.set(c.issue, c);
  const byLine = {};
  let bugs = 0;
  for (const report of newest.values()) {
    const held = fastTrackFacts(report.body).filter((fact) => !fact.yes);
    if (held.length > 0) bugs += 1;
    for (const fact of held) byLine[fact.name] = (byLine[fact.name] ?? 0) + 1;
  }
  return { bugs, byLine };
}

function heldAtExit(handoffs) {
  const reasons = new Map();
  for (const c of handoffs) {
    const holds = exitHolds(c.body);
    if (holds.length > 0) reasons.set(c.issue, holds);
  }
  const byReason = {};
  for (const reason of [...reasons.values()].flat()) byReason[reason] = (byReason[reason] ?? 0) + 1;
  return { issues: reasons.size, byReason };
}

function exitHolds(body) {
  const line = HELD_LINE.exec(body)?.[1] ?? "";
  const reasons = line
    .split("; ")
    .map((hold) => EXIT_HOLDS.find(([shape]) => shape.test(hold))?.[1])
    .filter(Boolean);
  return [...new Set(reasons)];
}

function followUp(bug, prs, comments) {
  const filed = Date.parse(bug.createdAt);
  const recent = prs.filter((p) => {
    const merged = Date.parse(p.mergedAt);
    return merged < filed && merged >= filed - FOLLOW_UP_DAYS * DAY;
  });
  const text = [
    bug.body ?? "",
    ...comments.filter((c) => c.issue === bug.number).map(rootCause),
  ].join("\n");
  const numbers = new Set([...text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])));
  const commits = text.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  const named = (p) =>
    numbers.has(p.number) ||
    p.closes.some((n) => numbers.has(n)) ||
    commits.some((sha) => p.mergeCommit?.startsWith(sha));
  return { bug: bug.number, prs: recent.filter(named).map((p) => p.number) };
}

function rootCause(comment) {
  if (fastTrackFacts(comment.body) === null) return "";
  return /^## Root cause\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(comment.body)?.[1] ?? "";
}

function bugHoursToMain(merged, issueOf) {
  const rows = [];
  for (const pr of merged) {
    const issue = issueOf.get(bugOf(pr));
    if (issue === undefined) continue;
    const hours = (Date.parse(pr.mergedAt) - Date.parse(issue.createdAt)) / 3_600_000;
    rows.push({ hours, fastTrack: issue.labels.includes("fast-track") });
  }
  const stat = (list) => ({
    prs: list.length,
    median: rounded(median(list.map((r) => r.hours))),
    p90: rounded(
      quantile(
        list.map((r) => r.hours),
        0.9,
      ),
    ),
  });
  return { all: stat(rows), fastTrack: stat(rows.filter((r) => r.fastTrack)) };
}

const rounded = (x) => (x === null ? null : Math.round(x * 10) / 10);

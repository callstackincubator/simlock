#!/usr/bin/env node
// Weekly numbers for the delivery pipeline, read from what it already writes on GitHub.
//
//   node .agents/scripts/delivery-stats.mjs [--weeks N] [--since YYYY-MM-DD] [--calibration]
//                                           [--repo owner/name] [--input file.json]
//
// One row per week for the last N weeks (default 5), newest last, from the `## Review` section of
// every PR merged in it (delivery rule 14): blocking findings each review raised and how many were
// confirmed and fixed, the notes raised, PRs that needed no fix or a second round, the median
// hours from opening to merge, review rounds and session tokens (the `Rounds: <n>. Tokens: <n>M.`
// line), and the `## Handoff` comments posted. A PR from before the blocking/note split says
// "n findings" instead of "b blocking, k notes"; all its findings count as raised. Then one row
// per PR merged since --since (default: this week) with its hours, size, rounds and tokens, this
// week's rejected findings, its handoffs, and the PRs waiting on hardware, for someone to read.
//
// --calibration prints instead the rejected findings of the last four weeks as Markdown, by
// review, newest first: the weekly `calibrate-reviews` routine writes it to
// .agents/briefs/calibration.md, which every reviewer reads before its diff.
//
// GitHub is read through repo-scoped REST only: a cloud session's GitHub proxy serves a fixed set
// of GraphQL queries (`gh pr list --json` is GraphQL) and refuses unscoped endpoints like search.
// --input reads the same data from a file instead:
// { now, prs: [{ number, title, createdAt, mergedAt, body, additions, deletions, changedFiles }],
//   handoffs: [{ issue, createdAt, body }], needsHardware: [{ number, title }] }.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CALIBRATION_WEEKS = 4;
const CALIBRATION_PER_REVIEW = 8;

const { values: options } = parseArgs({
  options: {
    weeks: { type: "string", default: "5" },
    since: { type: "string" },
    calibration: { type: "boolean", default: false },
    repo: { type: "string" },
    input: { type: "string" },
  },
});
const weeks = options.calibration ? CALIBRATION_WEEKS : Number(options.weeks);

const data =
  options.input === undefined
    ? fetchFromGitHub(new Date(), weeks)
    : JSON.parse(readFileSync(options.input, "utf8"));
console.log(options.calibration ? calibration(data) : report(data, weeks));

function repository() {
  if (options.repo !== undefined) return options.repo;
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = /([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) throw new Error(`Cannot read owner/name from origin ${url}; pass --repo`);
  return `${match[1]}/${match[2]}`;
}

function ghJson(args) {
  const out = execFileSync("gh", ["api", "-X", "GET", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

// why: `gh api --paginate` follows Link headers to numeric-ID repository URLs, which a cloud
// session's GitHub proxy refuses, so pages are requested by number against the repo-scoped path.
function ghPaged(path, fields) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = ghJson([
      path,
      ...fields.flatMap((f) => ["-f", f]),
      "-f",
      "per_page=100",
      "-f",
      `page=${page}`,
      "--jq",
      ".[] | @json",
    ]);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

function fetchFromGitHub(now, weekCount) {
  const repo = repository();
  const since = new Date(now.getTime() - weekCount * WEEK_MS);
  const prs = mergedSince(repo, since);
  const detailed = options.calibration ? [] : prs.filter((pr) => inRows(pr, now));
  for (const pr of detailed) {
    const [d] = ghJson([
      `repos/${repo}/pulls/${pr.number}`,
      "--jq",
      "{additions, deletions, changedFiles: .changed_files} | @json",
    ]);
    Object.assign(pr, d);
  }
  const handoffs = ghPaged(`repos/${repo}/issues/comments`, [`since=${since.toISOString()}`])
    .filter((c) => (c.body ?? "").startsWith("## Handoff"))
    .map((c) => ({
      issue: Number(c.issue_url.split("/").at(-1)),
      createdAt: c.created_at,
      body: c.body,
    }));
  const needsHardware = ghPaged(`repos/${repo}/issues`, ["state=open", "labels=needs-hardware"])
    .filter((i) => i.pull_request)
    .map((i) => ({ number: i.number, title: i.title }));
  return { now: now.toISOString(), prs, handoffs, needsHardware };
}

function mergedSince(repo, since) {
  const prs = [];
  // why: closed PRs come newest-updated first, and a PR merged in the window was updated in it,
  // so paging stops at the first page that reaches past `since`.
  for (let page = 1; ; page++) {
    const batch = ghJson([
      `repos/${repo}/pulls`,
      "-f",
      "state=closed",
      "-f",
      "sort=updated",
      "-f",
      "direction=desc",
      "-f",
      "per_page=100",
      "-f",
      `page=${page}`,
      "--jq",
      ".[] | {number, title, body, createdAt: .created_at, mergedAt: .merged_at, updatedAt: .updated_at} | @json",
    ]);
    for (const pr of batch) {
      if (pr.mergedAt !== null && new Date(pr.mergedAt) >= since) {
        const kept = { ...pr };
        delete kept.updatedAt;
        prs.push(kept);
      }
    }
    if (batch.length < 100 || new Date(batch[batch.length - 1].updatedAt) < since) {
      return prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    }
  }
}

function rowsStart(now) {
  if (options.since !== undefined) return new Date(options.since).getTime();
  return new Date(now).getTime() - WEEK_MS;
}

function inRows(pr, now) {
  return new Date(pr.mergedAt).getTime() >= rowsStart(now);
}

function reviewOf(body) {
  const section = reviewSection(body);
  if (section === null) return null;
  const spec = counts(section, "Spec");
  if (spec === null) return null;
  const code = counts(section, "Code") ?? zero();
  const claims = counts(section, "Claims") ?? zero();
  const comments = counts(section, "Comment") ?? zero();
  return {
    specFound: spec.found,
    specFixed: spec.fixed,
    codeFound: code.found,
    codeFixed: code.fixed,
    claimsFound: claims.found + comments.found,
    claimsFixed: claims.fixed + comments.fixed,
    notes: spec.notes + code.notes + claims.notes + comments.notes,
    rounds: roundsOf(body, section),
    tokens: tokensOf(section),
    rejected: rejectedIn(section),
  };
}

function zero() {
  return { found: 0, fixed: 0, notes: 0 };
}

function reviewSection(body) {
  const start = /^## Review[ \t]*$/m.exec(body);
  if (start === null) return null;
  const rest = body.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

function rejectedIn(section) {
  const list = /^Rejected:[ \t]*$/m.exec(section);
  if (list === null) return [];
  const rejected = [];
  for (const line of section.slice(list.index).split("\n")) {
    const item = /^- (?:(spec|code|claims|comments): )?(.+)$/.exec(line.trim());
    if (item !== null) rejected.push({ review: item[1] ?? "untagged", text: item[2] });
  }
  return rejected;
}

// why: PRs from before the blocking/note split say "Spec review: 7 findings, 1 fixed".
function counts(section, review) {
  const match = new RegExp(
    `${review} review: (\\d+) (?:findings?|blocking), (\\d+) fixed(?:, (\\d+) notes?)?`,
  ).exec(section);
  if (match === null) return null;
  return { found: Number(match[1]), fixed: Number(match[2]), notes: Number(match[3] ?? 0) };
}

function roundsOf(body, section) {
  const line = /^Rounds: (\d+)\./m.exec(section);
  if (line !== null) return Number(line[1]);
  const listed = [...section.matchAll(/^Round (\d+) \(/gm)].map((m) => Number(m[1]));
  if (listed.length > 0) return Math.max(...listed);
  const status = /Review: (?:round|passed \()(\d+)/.exec(body);
  return status === null ? 1 : Number(status[1]);
}

function tokensOf(section) {
  const line = /^Rounds: \d+\. Tokens: ([\d.]+)M\./m.exec(section);
  return line === null ? null : Number(line[1]);
}

function blockedOn(body) {
  const heading = /^#{2,4} Blocked on[ \t]*$/m.exec(body);
  if (heading === null) return "no Blocked on section";
  const lines = body.slice(heading.index + heading[0].length).split("\n");
  return lines.map((line) => line.trim()).find((line) => line !== "") ?? "empty";
}

function rate(fixed, found) {
  return found === 0 ? "0/0" : `${fixed}/${found} (${Math.round((100 * fixed) / found)}%)`;
}

function median(values) {
  const sorted = values
    .filter((v) => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function hoursOpen(pr) {
  if (!pr.createdAt) return null;
  return (new Date(pr.mergedAt).getTime() - new Date(pr.createdAt).getTime()) / 3_600_000;
}

function show(n, digits = 1) {
  return n === null ? "-" : n.toFixed(digits);
}

function report({ now, prs, handoffs, needsHardware }, weekCount) {
  const end = new Date(now).getTime();
  const windows = Array.from({ length: weekCount }, (_, i) => {
    const to = end - (weekCount - 1 - i) * WEEK_MS;
    return { from: to - WEEK_MS, to };
  });
  const thisWeek = windows[windows.length - 1];
  const lines = [
    `# Delivery stats, ${weekCount} weeks to ${new Date(end).toISOString().slice(0, 10)}`,
    "",
    "Review columns are confirmed-and-fixed / blocking raised (every finding raised, on PRs",
    "from before the blocking/note split). Rejected = raised − fixed. Notes are never verified.",
    "Hours, rounds and tokens are medians over the week's reviewed PRs; tokens are the session's",
    "total when the PR body was finished, so a run of several PRs counts them cumulatively.",
    "",
    "| Week from | Merged | Reviewed | Spec review | Code review | Claims review | Notes | No fix | Round 2 | Hours | Rounds | Tokens | Handoffs |",
    "| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    ...windows.map((window) => weekRow(window, prs, handoffs)),
    ...prRows(prs, now),
    ...rejectedSection(prs, thisWeek),
    ...handoffSection(handoffs, thisWeek),
    "",
    `## Open PRs waiting on hardware (${needsHardware.length})`,
    "",
    ...needsHardware.map((pr) => `- #${pr.number} ${pr.title}`),
  ];
  return lines.join("\n");
}

function inWindow(iso, { from, to }) {
  const t = new Date(iso).getTime();
  return t >= from && t < to;
}

function weekRow(window, prs, handoffs) {
  const merged = prs.filter((pr) => inWindow(pr.mergedAt, window));
  const reviewed = merged
    .map((pr) => ({ pr, review: reviewOf(pr.body ?? "") }))
    .filter((r) => r.review !== null);
  const reviews = reviewed.map((r) => r.review);
  const sum = (key) => reviews.reduce((total, r) => total + Number(r[key]), 0);
  return (
    `| ${new Date(window.from).toISOString().slice(0, 10)} | ${merged.length} | ${reviews.length}` +
    ` | ${rate(sum("specFixed"), sum("specFound"))} | ${rate(sum("codeFixed"), sum("codeFound"))}` +
    ` | ${rate(sum("claimsFixed"), sum("claimsFound"))}` +
    ` | ${sum("notes")}` +
    ` | ${reviews.filter((r) => r.specFixed + r.codeFixed + r.claimsFixed === 0).length}` +
    ` | ${reviews.filter((r) => r.rounds >= 2).length}` +
    ` | ${show(median(reviewed.map((r) => hoursOpen(r.pr))))}` +
    ` | ${show(median(reviews.map((r) => r.rounds)), 0)}` +
    ` | ${show(median(reviews.map((r) => r.tokens)))}` +
    ` | ${handoffs.filter((h) => inWindow(h.createdAt, window)).length} |`
  );
}

function linesOf(pr) {
  return pr.additions === undefined ? null : pr.additions + pr.deletions;
}

function prRows(prs, now) {
  const rows = prs.filter((pr) => inRows(pr, now));
  const reviews = rows.map((pr) => reviewOf(pr.body ?? ""));
  const reviewed = reviews.filter((r) => r !== null);
  return [
    "",
    `## PRs merged since ${new Date(rowsStart(now)).toISOString().slice(0, 10)} (${rows.length})`,
    "",
    "| PR | Hours | Files | Lines | Rounds | Tokens | Title |",
    "| --- | --: | --: | --: | --: | --: | --- |",
    ...rows.map(
      (pr, i) =>
        `| #${pr.number} | ${show(hoursOpen(pr))} | ${pr.changedFiles ?? "-"} | ${linesOf(pr) ?? "-"}` +
        ` | ${reviews[i]?.rounds ?? "-"} | ${reviews[i]?.tokens == null ? "-" : `${reviews[i].tokens}M`}` +
        ` | ${pr.title.slice(0, 60)} |`,
    ),
    "",
    `Medians: ${show(median(rows.map(hoursOpen)))} hours, ${show(median(rows.map(linesOf)), 0)} lines,` +
      ` ${show(median(reviewed.map((r) => r.rounds)), 0)} rounds, ${show(median(reviewed.map((r) => r.tokens)))}M tokens.`,
  ];
}

function rejectedSection(prs, window) {
  const rejected = prs
    .filter((pr) => inWindow(pr.mergedAt, window))
    .flatMap((pr) =>
      (reviewOf(pr.body ?? "")?.rejected ?? []).map((r) => ({ ...r, pr: pr.number })),
    );
  const lines = ["", `## Rejected findings this week (${rejected.length})`];
  for (const review of ["spec", "code", "claims", "comments", "untagged"]) {
    const group = rejected.filter((r) => r.review === review);
    if (group.length === 0) continue;
    lines.push("", `### ${review} (${group.length})`, "");
    for (const r of group) lines.push(`- #${r.pr} ${r.text}`);
  }
  return lines;
}

function handoffSection(handoffs, window) {
  const week = handoffs.filter((h) => inWindow(h.createdAt, window));
  return [
    "",
    `## Handoffs this week (${week.length})`,
    "",
    ...week.map((h) => `- #${h.issue} blocked on: ${blockedOn(h.body ?? "")}`),
  ];
}

function calibration({ now, prs }) {
  const rejected = prs.flatMap((pr) =>
    (reviewOf(pr.body ?? "")?.rejected ?? []).map((r) => ({ ...r, pr: pr.number })),
  );
  const lines = [
    `# Findings rejected in the ${CALIBRATION_WEEKS} weeks to ${new Date(now).toISOString().slice(0, 10)}`,
    "",
    "Each line below was raised as blocking and rejected when it was verified against the code,",
    "with the reason after the dash. A finding like one of these is right only with evidence that",
    "distinguishes it from the rejected one: name the input or state that makes this one differ.",
    "",
    `Written by \`node .agents/scripts/delivery-stats.mjs --calibration\`; ${rejected.length} rejected findings in all.`,
  ];
  for (const review of ["spec", "code", "claims"]) {
    const group = rejected
      .filter((r) => r.review === review || (review === "claims" && r.review === "comments"))
      .slice(0, CALIBRATION_PER_REVIEW);
    lines.push("", `## ${review} review`, "");
    if (group.length === 0) lines.push("- none");
    for (const r of group) lines.push(`- #${r.pr} ${r.text}`);
  }
  return lines.join("\n");
}

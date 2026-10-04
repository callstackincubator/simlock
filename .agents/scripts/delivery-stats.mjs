#!/usr/bin/env node
// Weekly numbers for the delivery pipeline, read from what it already writes on GitHub.
//
//   node .agents/scripts/delivery-stats.mjs [--weeks N] [--repo owner/name] [--input file.json]
//
// One row per week for the last N weeks (default 5), newest last, from the `## Review` section of
// every PR merged in it (delivery rule 14): findings each review raised and how many were
// confirmed and fixed, PRs that needed no fix or a second round, mutants left alive, and the
// `## Handoff` comments posted. Then this week's rejected findings, its handoffs, and the PRs
// waiting on hardware, for someone to read.
//
// GitHub is read through REST only: a cloud session's GitHub proxy serves a fixed set of GraphQL
// queries, and `gh pr list --json` is GraphQL. --input reads the same data from a file instead:
// { now, prs: [{ number, title, mergedAt, body }], handoffs: [{ issue, createdAt, body }],
//   needsHardware: [{ number, title }] }.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const { values: options } = parseArgs({
  options: {
    weeks: { type: "string", default: "5" },
    repo: { type: "string" },
    input: { type: "string" },
  },
});
const weeks = Number(options.weeks);

const data =
  options.input === undefined
    ? fetchFromGitHub(new Date(), weeks)
    : JSON.parse(readFileSync(options.input, "utf8"));
console.log(report(data, weeks));

/** `owner/name` from --repo, GH_REPO, or the last two segments of origin's URL. */
function repository() {
  if (options.repo !== undefined) return options.repo;
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = /([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) throw new Error(`Cannot read owner/name from origin ${url}; pass --repo`);
  return `${match[1]}/${match[2]}`;
}

/** Every JSON value `gh api --jq '... | @json'` printed, one per line. */
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

function fetchFromGitHub(now, weekCount) {
  const repo = repository();
  const since = new Date(now.getTime() - weekCount * WEEK_MS);
  const day = since.toISOString().slice(0, 10);
  const prs = ghJson([
    "search/issues",
    "-f",
    `q=repo:${repo} is:pr is:merged merged:>=${day}`,
    "-f",
    "per_page=100",
    "--paginate",
    "--jq",
    ".items[] | {number, title, body, mergedAt: .pull_request.merged_at} | @json",
  ]);
  const handoffs = ghJson([
    `repos/${repo}/issues/comments`,
    "-f",
    `since=${since.toISOString()}`,
    "-f",
    "per_page=100",
    "--paginate",
    "--jq",
    '.[] | select((.body // "") | startswith("## Handoff"))' +
      ' | {issue: (.issue_url | split("/") | last | tonumber), createdAt: .created_at, body} | @json',
  ]);
  const needsHardware = ghJson([
    "search/issues",
    "-f",
    `q=repo:${repo} is:pr is:open label:needs-hardware`,
    "--jq",
    ".items[] | {number, title} | @json",
  ]);
  return { now: now.toISOString(), prs, handoffs, needsHardware };
}

/** What one PR's `## Review` section says, or null when it has no counts line. */
function reviewOf(body) {
  const start = /^## Review[ \t]*$/m.exec(body);
  if (start === null) return null;
  const rest = body.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);

  const spec = /Spec review: (\d+) findings?, (\d+) fixed/.exec(section);
  if (spec === null) return null;
  const code = /Code review: (\d+) findings?, (\d+) fixed/.exec(section);
  const mutate = /Mutate: (\d+) mutants?, (\d+) alive/.exec(section);

  const rejected = [];
  const list = /^Rejected:[ \t]*$/m.exec(section);
  if (list !== null) {
    for (const line of section.slice(list.index).split("\n")) {
      const item = /^- (?:(spec|code): )?(.+)$/.exec(line.trim());
      if (item !== null) rejected.push({ review: item[1] ?? "untagged", text: item[2] });
    }
  }

  return {
    specFound: Number(spec[1]),
    specFixed: Number(spec[2]),
    codeFound: code === null ? 0 : Number(code[1]),
    codeFixed: code === null ? 0 : Number(code[2]),
    mutants: mutate === null ? 0 : Number(mutate[1]),
    alive: mutate === null ? 0 : Number(mutate[2]),
    secondRound: /Review: round 2/.test(body),
    rejected,
  };
}

/** The first line of a handoff's Blocked on section. */
function blockedOn(body) {
  const heading = /^#{2,4} Blocked on[ \t]*$/m.exec(body);
  if (heading === null) return "no Blocked on section";
  const lines = body.slice(heading.index + heading[0].length).split("\n");
  return lines.map((line) => line.trim()).find((line) => line !== "") ?? "empty";
}

function rate(fixed, found) {
  return found === 0 ? "0/0" : `${fixed}/${found} (${Math.round((100 * fixed) / found)}%)`;
}

function report({ now, prs, handoffs, needsHardware }, weekCount) {
  const end = new Date(now).getTime();
  const windows = Array.from({ length: weekCount }, (_, i) => {
    const to = end - (weekCount - 1 - i) * WEEK_MS;
    return { from: to - WEEK_MS, to };
  });
  const inWindow = (iso, { from, to }) => {
    const t = new Date(iso).getTime();
    return t >= from && t < to;
  };

  const lines = [
    `# Delivery stats, ${weekCount} weeks to ${new Date(end).toISOString().slice(0, 10)}`,
    "",
    "Spec and code columns are confirmed-and-fixed / raised. Rejected = raised − fixed.",
    "",
    "| Week from | Merged | Reviewed | Spec review | Code review | No fix | Round 2 | Mutants alive | Handoffs |",
    "| --- | --: | --: | --: | --: | --: | --: | --: | --: |",
  ];
  for (const window of windows) {
    const merged = prs.filter((pr) => inWindow(pr.mergedAt, window));
    const reviews = merged.map((pr) => reviewOf(pr.body ?? "")).filter((r) => r !== null);
    const sum = (key) => reviews.reduce((total, r) => total + Number(r[key]), 0);
    lines.push(
      `| ${new Date(window.from).toISOString().slice(0, 10)} | ${merged.length} | ${reviews.length}` +
        ` | ${rate(sum("specFixed"), sum("specFound"))} | ${rate(sum("codeFixed"), sum("codeFound"))}` +
        ` | ${reviews.filter((r) => r.specFixed + r.codeFixed === 0).length} | ${sum("secondRound")}` +
        ` | ${sum("alive")}/${sum("mutants")}` +
        ` | ${handoffs.filter((h) => inWindow(h.createdAt, window)).length} |`,
    );
  }

  const thisWeek = windows[windows.length - 1];
  const rejected = prs
    .filter((pr) => inWindow(pr.mergedAt, thisWeek))
    .flatMap((pr) =>
      (reviewOf(pr.body ?? "")?.rejected ?? []).map((r) => ({ ...r, pr: pr.number })),
    );
  lines.push("", `## Rejected findings this week (${rejected.length})`);
  for (const review of ["spec", "code", "untagged"]) {
    const group = rejected.filter((r) => r.review === review);
    if (group.length === 0) continue;
    lines.push("", `### ${review} (${group.length})`, "");
    for (const r of group) lines.push(`- #${r.pr} ${r.text}`);
  }

  const weekHandoffs = handoffs.filter((h) => inWindow(h.createdAt, thisWeek));
  lines.push("", `## Handoffs this week (${weekHandoffs.length})`, "");
  for (const h of weekHandoffs) lines.push(`- #${h.issue} blocked on: ${blockedOn(h.body ?? "")}`);

  lines.push("", `## Open PRs waiting on hardware (${needsHardware.length})`, "");
  for (const pr of needsHardware) lines.push(`- #${pr.number} ${pr.title}`);

  return lines.join("\n");
}

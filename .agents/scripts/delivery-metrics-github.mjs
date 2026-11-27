// For delivery-metrics.mjs: what it reads from GitHub, through `gh`. Read-only.
//
//   mergedPrs(repo, since, now)        PRs merged since the time, a week a query
//   withFiles(repo, pr)                the PR with its changed paths
//   autonomyData(repo, since, now)     issues updated and issue comments written since the
//                                      time, and how many issues and PRs carry a decision
//                                      delivery took that the maintainer has not confirmed
import { execFileSync } from "node:child_process";

const DAY = 24 * 60 * 60 * 1000;
const PR_FIELDS =
  "number,title,headRefName,baseRefName,createdAt,mergedAt,additions,deletions,changedFiles,body,closingIssuesReferences,mergeCommit";
const ISSUE_FIELDS = "number,title,labels,createdAt,closedAt,body,state";
const PENDING = '"decided in delivery, pending the maintainer"';

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 29 }));
}

// why: one search answers with at most 1000 rows, so the time is walked a week at a time.
function weeks(since, now) {
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const ranges = [];
  for (let t = since; t < now + DAY; t += 7 * DAY) ranges.push(`${day(t)}..${day(t + 6 * DAY)}`);
  return ranges;
}

export function mergedPrs(repo, since, now) {
  const list = (range) =>
    gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--search",
      `merged:${range}`,
      "--limit",
      "1000",
      "--json",
      PR_FIELDS,
    ]);
  return weeks(since, now)
    .flatMap(list)
    .map((pr) => ({
      ...pr,
      closes: (pr.closingIssuesReferences ?? []).map((issue) => issue.number),
      closingIssuesReferences: undefined,
      mergeCommit: pr.mergeCommit?.oid ?? null,
    }))
    .sort((a, b) => a.number - b.number);
}

export function withFiles(repo, pr) {
  const { files } = gh(["pr", "view", String(pr.number), "--repo", repo, "--json", "files"]);
  return { ...pr, files: files.map((f) => ({ path: f.path })) };
}

export function autonomyData(repo, since, now) {
  const list = (range) =>
    gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      `updated:${range}`,
      "--limit",
      "1000",
      "--json",
      ISSUE_FIELDS,
    ]);
  const issues = new Map();
  for (const issue of weeks(since, now).flatMap(list)) {
    issues.set(issue.number, { ...issue, labels: issue.labels.map((l) => l.name) });
  }
  return {
    issues: [...issues.values()].sort((a, b) => a.number - b.number),
    comments: commentsSince(repo, since),
    pendingDecisions: gh(["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} ${PENDING}`])
      .total_count,
  };
}

function commentsSince(repo, since) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = gh([
      "api",
      "-X",
      "GET",
      `repos/${repo}/issues/comments`,
      "-f",
      `since=${new Date(since).toISOString()}`,
      "-f",
      "sort=created",
      "-f",
      "direction=asc",
      "-f",
      "per_page=100",
      "-f",
      `page=${page}`,
    ]);
    for (const c of batch) {
      comments.push({
        issue: Number(c.issue_url.split("/").at(-1)),
        createdAt: c.created_at,
        body: c.body ?? "",
      });
    }
    if (batch.length < 100) return comments;
  }
}

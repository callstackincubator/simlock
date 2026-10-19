#!/usr/bin/env node
// `node .agents/scripts/recurring-findings.mjs [--days <n>] [--min-prs <n>]`: which classes of review
// finding were fixed in at least --min-prs (default 3) pull requests merged in the last --days
// (default 28), read from each PR's `## Review ledger` comment (docs/internal/REVIEW.md,
// "Measurement"): the findings file in its `json` code block.
//
// Prints one line for the window, then one per class that recurs, most PRs first:
//
//   Window: 2026-09-21 to 2026-10-19. Merged PRs: 40, with a review ledger: 31.
//   testing 2: 4 PRs (#701, #698, #690, #688) src/a.ts:12, src/b.ts:40, ...
//
// The repo is GH_REPO, else the origin remote's owner/name. It calls repo-scoped REST only: a
// cloud session's GitHub proxy refuses GraphQL.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const days = option("--days", 28);
const minPrs = option("--min-prs", 3);
if (!(Number.isInteger(days) && days > 0 && Number.isInteger(minPrs) && minPrs > 0)) {
  console.error("usage: recurring-findings.mjs [--days <n>] [--min-prs <n>]");
  process.exit(64);
}

const nwo =
  process.env.GH_REPO ??
  execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })
    .trim()
    .replace(/\.git$/, "")
    .replace(/.*[/:]([^/:]+\/[^/]+)$/, "$1");
const now = Date.now();
const since = now - days * 24 * 60 * 60 * 1000;

const merged = [];
for (let page = 1; ; page++) {
  const pulls = get("pulls", { state: "closed", sort: "updated", direction: "desc", page });
  for (const pull of pulls) {
    if (pull.merged_at !== null && Date.parse(pull.merged_at) >= since) merged.push(pull.number);
  }
  // why: sorted by update, so once a page ends before the window no later page reaches into it.
  if (pulls.length < 100 || Date.parse(pulls.at(-1).updated_at) < since) break;
}

const classes = new Map();
let withLedger = 0;
for (const pr of merged) {
  const findings = ledgerFindings(pr);
  if (findings === null) continue;
  withLedger += 1;
  for (const f of findings.filter((x) => x.outcome === "fixed")) {
    const key = String(f.class).trim().toLowerCase();
    const entry = classes.get(key) ?? { prs: new Set(), paths: [] };
    entry.prs.add(pr);
    entry.paths.push(f.path);
    classes.set(key, entry);
  }
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log(
  `Window: ${day(since)} to ${day(now)}. Merged PRs: ${merged.length}, with a review ledger: ${withLedger}.`,
);
const recurring = [...classes.entries()]
  .filter(([, e]) => e.prs.size >= minPrs)
  .sort((a, b) => b[1].prs.size - a[1].prs.size || a[0].localeCompare(b[0]));
for (const [name, e] of recurring) {
  const prs = [...e.prs].map((n) => `#${n}`).join(", ");
  console.log(`${name}: ${e.prs.size} PRs (${prs}) ${e.paths.slice(0, 5).join(", ")}`);
}
if (recurring.length === 0) console.log(`No class was fixed in ${minPrs} or more PRs.`);

function ledgerFindings(pr) {
  for (let page = 1; ; page++) {
    const comments = get(`issues/${pr}/comments`, { page });
    const ledger = comments.find(({ body }) => /^## Review ledger\s*$/m.test(body ?? ""));
    if (ledger !== undefined) return findingsIn(ledger.body.replace(/\r/g, ""));
    if (comments.length < 100) return null;
  }
}

function findingsIn(text) {
  const block = /```json\n([\s\S]*?)\n```/.exec(text);
  try {
    const findings = block === null ? null : JSON.parse(block[1]).findings;
    return Array.isArray(findings) ? findings : null;
  } catch {
    return null;
  }
}

function get(path, fields) {
  const flags = Object.entries({ per_page: 100, ...fields }).flatMap(([k, v]) => [
    "-f",
    `${k}=${v}`,
  ]);
  const out = execFileSync("gh", ["api", "-X", "GET", `repos/${nwo}/${path}`, ...flags], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

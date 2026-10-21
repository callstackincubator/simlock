#!/usr/bin/env node
// `node .agents/scripts/pr-body-check.mjs <pr> [--draft-ok]`: the mechanical half of delivery
// rules 12, 14 and 15 for a PR body, so no prose has to repeat them. It fails (exit 1, one
// `pr-body: ...` line per defect) when:
//
//   - the last line is not `*Written by an agent.*` (rule 12);
//   - there is no `## Review` section, or its first line is not the counts line
//     `Spec review: <b> blocking, <m> fixed, <k> notes. Code review: ... Claims review: ...`
//     (`skipped` in place of the counts for a review the diff's kind left out) (rule 14);
//   - a line under `Rejected:` is not tagged `spec:`, `code:` or `claims:` (rule 14);
//   - the body says "spec needs" anywhere outside a code block (rule 15);
//   - on a <kind>/<n> branch, `### Status` or `## Assumptions` is missing (coding rule 2);
//   - on a <kind>/<n> branch, the Review counts line names a review that ran and the PR has no
//     comment headed `## Review ledger` (REVIEW.md, "Measurement"); checked only with a PR number.
//
// It warns (exit 0) when the Review section has no `Rounds: <n>. Tokens: <n>M.` line, or the
// prose runs over 200 words: everything outside code blocks, checklist lines and the Status,
// Assumptions and Review sections (rule 12). `--draft-ok` turns every failure into a warning,
// for the check that runs while the PR is still a draft. `--body-file <f> [--branch <b>]` reads
// a body from a file instead of GitHub. The repo is GH_REPO, else the origin remote's owner/name.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BUDGET = 200;
const REVIEW_COUNTS =
  /^Spec review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\. Code review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\. Claims review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\.(?: Comment review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\.)?\s*$/;
const ROUNDS = /^Rounds: \d+\. Tokens: (?:[\d.]+M|n\/a)\.\s*$/m;

const args = process.argv.slice(2);
const draftOk = args.includes("--draft-ok");
let body;
let branch = "";
let prNumber = null;
const fileAt = args.indexOf("--body-file");
if (fileAt !== -1) {
  body = readFileSync(args[fileAt + 1], "utf8");
  const branchAt = args.indexOf("--branch");
  if (branchAt !== -1) branch = args[branchAt + 1];
} else {
  const pr = args.find((a) => /^\d+$/.test(a));
  if (pr === undefined) {
    console.error("usage: pr-body-check.mjs <pr> [--draft-ok] | --body-file <f> [--branch <b>]");
    process.exit(64);
  }
  // why: a cloud session's GitHub proxy refuses GraphQL, which `gh pr view` uses; repo-scoped
  // REST works.
  const pull = JSON.parse(
    execFileSync("gh", ["api", "-X", "GET", `repos/${repository()}/pulls/${pr}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  body = pull.body ?? "";
  branch = pull.head.ref;
  prNumber = pr;
}
body = body.replace(/\r/g, "");

const failures = [];
const warnings = [];
const prose = withoutCodeBlocks(body);
const lines = prose.split("\n");

const last =
  body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1) ?? "";
if (!/^[*_]Written by an agent\.[*_]$/.test(last)) {
  failures.push('the last line is not "*Written by an agent.*" (delivery rule 12)');
}

const review = section(lines, /^## Review\s*$/);
if (review === null) {
  failures.push("no `## Review` section (delivery rule 14)");
} else {
  const first = review.find((l) => l.trim() !== "") ?? "";
  if (!REVIEW_COUNTS.test(first)) {
    failures.push(
      "the `## Review` section does not start with the counts line " +
        '"Spec review: <b> blocking, <m> fixed, <k> notes. Code review: ... Claims review: ..." (delivery rule 14)',
    );
  }
  if (!ROUNDS.test(review.join("\n"))) {
    warnings.push('the `## Review` section has no "Rounds: <n>. Tokens: <n>M." line');
  }
  if (/^Assessment: incomplete\b/im.test(review.join("\n"))) {
    failures.push("review assessment is incomplete; resolve missing coverage before ready");
  }
  const at = review.findIndex((l) => /^Rejected:\s*$/.test(l));
  if (at !== -1) {
    for (const l of review.slice(at + 1)) {
      if (!l.startsWith("- ")) continue;
      if (!/^- (spec|code|claims|comments): /.test(l)) {
        failures.push(
          `a Rejected line is not tagged spec:, code: or claims:: "${l.slice(0, 60)}" (delivery rule 14)`,
        );
      }
    }
  }
}

if (/spec needs/i.test(prose)) {
  failures.push(
    'the body says "spec needs": the spec must change before this PR merges (delivery rule 15)',
  );
}

if (/^(bug|feature|task)\/\d+$/.test(branch)) {
  if (section(lines, /^### Status\s*$/) === null) failures.push("no `### Status` section");
  if (section(lines, /^## Assumptions\s*$/) === null) {
    failures.push("no `## Assumptions` section (coding rule 2)");
  }
}

// why: only a delivery PR (<kind>/<n>) has a ledger; a routine's or a person's chore PR gets
// the reviewer's findings comment instead.
if (
  prNumber !== null &&
  /^(bug|feature|task)\/\d+$/.test(branch) &&
  lines.some(
    (l) =>
      REVIEW_COUNTS.test(l) &&
      !/^(Spec|Code|Claims) review: skipped\. (Code|Claims) review: skipped\. Claims review: skipped\.$/.test(
        l,
      ),
  )
) {
  const comments = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "GET",
        `repos/${repository()}/issues/${prNumber}/comments`,
        "-f",
        "per_page=100",
      ],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    ),
  );
  if (!comments.some((c) => /^## Review ledger\s*$/m.test(c.body ?? ""))) {
    failures.push("no comment headed `## Review ledger` (REVIEW.md, Measurement)");
  }
}

const words = budgetedWords(lines);
if (words > BUDGET) {
  warnings.push(
    `${words} words outside the checklist, Status, Assumptions and Review; the budget is ${BUDGET} (delivery rule 12)`,
  );
}

const gh = process.env.GITHUB_ACTIONS === "true";
for (const w of warnings) console.log(`${gh ? "::warning::" : "pr-body: warning: "}${w}`);
for (const f of failures) {
  console.log(`${gh ? (draftOk ? "::warning::" : "::error::") : "pr-body: "}${f}`);
}
process.exit(failures.length > 0 && !draftOk ? 1 : 0);

function repository() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = /([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) throw new Error(`Cannot read owner/name from origin ${url}; set GH_REPO`);
  return `${match[1]}/${match[2]}`;
}

function withoutCodeBlocks(text) {
  let inside = false;
  return text
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        inside = !inside;
        return "";
      }
      return inside ? "" : l;
    })
    .join("\n");
}

function section(all, heading) {
  const start = all.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  const level = /^(#+)/.exec(all[start])[1].length;
  const out = [];
  for (const l of all.slice(start + 1)) {
    const h = /^(#+)\s/.exec(l);
    if (h !== null && h[1].length <= level) break;
    out.push(l);
  }
  return out;
}

function budgetedWords(all) {
  let skipping = 0;
  let count = 0;
  for (const l of all) {
    const h = /^(#+)\s+(.*)$/.exec(l);
    if (h !== null) {
      const level = h[1].length;
      if (skipping > 0 && level <= skipping) skipping = 0;
      if (
        skipping === 0 &&
        /^(Status|Assumptions|Review|Mutants?\b.*|Alive mutants|Review notes)/i.test(h[2])
      ) {
        skipping = level;
      }
      continue;
    }
    if (skipping > 0 || /^\s*- \[[ x]\]/i.test(l)) continue;
    count += l.split(/\s+/).filter((w) => /\w/.test(w)).length;
  }
  return count;
}

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
//     The ledger's json block has no finding whose `outcome` is `open`, and the `## Review`
//     section has the line `Assessment: complete` (rule 15). The ledger's `Round <r>: <sha>`
//     lines are 40-hex SHAs with at most one round 1 and one round 2, round 1 first, each an
//     ancestor of the head (a warning when this clone lacks a SHA); at most one comment is
//     headed `## Review notes` (REVIEW.md, the cap);
//   - `## Assumptions` holds lines other than `none` or `- Assumption: <q> — <choice>` (coding
//     rule 2);
//   - the prose runs over 200 words: everything outside code blocks, checklist lines and the
//     Status, Assumptions and Review sections (rule 12);
//   - with a PR number, on a <kind>/<n> branch: a `## Done when` bullet of issue <n> matches no
//     `- [ ]` or `- [x]` line of the body, or matches one that is not ticked. A line matches when
//     it holds at least half the bullet's content words (lowercased, camelCase split, punctuation
//     dropped, a trailing `s` dropped, stop words left out; words in code spans and parentheses
//     count only when nothing else is left), so it may reword the bullet or add `— <how
//     checked>`; and when every
//     other open sub-issue of the issue's parent is closed by a PR below this one in its stack
//     (or there is none), the same for the parent's `## Completion conditions` (coding rule 5);
//   - the diff's kind (`diff-kind.mjs` from the merge-base to the head) and the counts line
//     disagree: Code review skipped on a `full`, `large` or `tests-only` diff, or Spec review
//     skipped on a <kind>/<n> branch (REVIEW.md, "Routing"); a Claims review that ran on an
//     `adr-only` diff is a warning;
//   - a routine's branch changed what its routine may not: `chore/garden-comments-*` is
//     `comments-only`, `chore/audit-tests-*` and `chore/harden-tests-*` are `tests-only`, and
//     `chore/calibrate-reviews-*` changes `.agents/briefs/calibration.md` alone.
//
// The diff is read from this clone: a PR's base and head SHAs, or `--base <sha> --head <sha>`;
// `--kind <kind>` gives the kind instead. A PR whose SHAs this clone lacks gets a warning in
// place of the diff checks. It warns (exit 0) when the Review section has no `Rounds: <n>.
// Tokens: <n>M.` line. `--draft-ok` turns every failure into a warning, for the check that runs
// while the PR is still a draft. `--body-file <f> [--branch <b>]` reads a body from a file
// instead of GitHub. The repo is GH_REPO, else the origin remote's owner/name.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { option } from "./cli-args.mjs";

const BUDGET = 200;
const HERE = dirname(fileURLToPath(import.meta.url));
// why: the check catches a line the PR never walked, not paraphrase; half the words is enough.
const MATCH = 0.5;
const STOP_WORDS = new Set(
  "a an the and or but nor of to in on at by for with from into onto as is are was were be been it its this that these those than then there their they them which who whom what when where how all any each every both either no not only so such too very can could may might must shall should will would do doe did has have had here our we you your one".split(
    " ",
  ),
);
const REVIEW_COUNTS =
  /^Spec review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\. Code review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\. Claims review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\.(?: Comment review: (?:\d+ blocking, \d+ fixed, \d+ notes?|skipped)\.)?\s*$/;
const ROUNDS = /^Rounds: \d+\. Tokens: (?:[\d.]+M|n\/a)\.\s*$/m;

const DELIVERY_BRANCH = /^(bug|feature|task)\/(\d+)$/;
const ROUTINES = [
  [/^chore\/garden-comments-/, "comments-only"],
  [/^chore\/(?:audit|harden)-tests-/, "tests-only"],
];
const CALIBRATION = ".agents/briefs/calibration.md";

const args = process.argv.slice(2);
const draftOk = args.includes("--draft-ok");
let body;
let branch = "";
let prNumber = null;
let pull = null;
let diffBase = option("--base", args);
let diffHead = option("--head", args);
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
  pull = api(`pulls/${pr}`);
  body = pull.body ?? "";
  branch = pull.head.ref;
  prNumber = pr;
  diffHead = pull.head.sha ?? null;
  diffBase = pull.base?.sha ?? null;
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
  } else if (DELIVERY_BRANCH.test(branch) && !/^Assessment: complete\b/m.test(review.join("\n"))) {
    failures.push("the `## Review` section has no `Assessment: complete` line (delivery rule 15)");
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

if (DELIVERY_BRANCH.test(branch)) {
  if (section(lines, /^### Status\s*$/) === null) failures.push("no `### Status` section");
  if (section(lines, /^## Assumptions\s*$/) === null) {
    failures.push("no `## Assumptions` section (coding rule 2)");
  }
}
for (const l of section(lines, /^## Assumptions\s*$/) ?? []) {
  if (l.trim() === "" || /^none\.?$/i.test(l.trim()) || /^- Assumption: .+ — .+/.test(l)) continue;
  failures.push(
    `an Assumptions line is not "none" or "- Assumption: <question> — <choice>": "${l.slice(0, 60)}" (coding rule 2)`,
  );
}

// why: only a delivery PR (<kind>/<n>) has a ledger; a routine's or a person's chore PR gets
// the reviewer's findings comment instead.
if (
  prNumber !== null &&
  DELIVERY_BRANCH.test(branch) &&
  lines.some(
    (l) =>
      REVIEW_COUNTS.test(l) &&
      !/^(Spec|Code|Claims) review: skipped\. (Code|Claims) review: skipped\. Claims review: skipped\.$/.test(
        l,
      ),
  )
) {
  const comments = api(`issues/${prNumber}/comments`, "-f", "per_page=100");
  const ledger = comments.find((c) => /^## Review ledger\s*$/m.test(c.body ?? ""));
  if (ledger === undefined) {
    failures.push("no comment headed `## Review ledger` (REVIEW.md, Measurement)");
  } else {
    checkLedger(ledger.body.replace(/\r/g, ""));
  }
  if (comments.filter((c) => /^## Review notes\s*$/m.test(c.body ?? "")).length > 1) {
    failures.push(
      "more than one comment is headed `## Review notes`; notes go out once (REVIEW.md)",
    );
  }
}

if (prNumber !== null && DELIVERY_BRANCH.test(branch)) checkDoneWhen();
checkDiff();

const words = budgetedWords(lines);
if (words > BUDGET) {
  failures.push(
    `${words} words outside the checklist, Status, Assumptions and Review; the budget is ${BUDGET}: cut it (delivery rule 12)`,
  );
}

const gh = process.env.GITHUB_ACTIONS === "true";
for (const w of warnings) console.log(`${gh ? "::warning::" : "pr-body: warning: "}${w}`);
for (const f of failures) {
  console.log(`${gh ? (draftOk ? "::warning::" : "::error::") : "pr-body: "}${f}`);
}
process.exit(failures.length > 0 && !draftOk ? 1 : 0);

function checkLedger(text) {
  for (const f of ledgerFindings(text).filter((f) => f.outcome === "open")) {
    failures.push(`finding ${f.id} is open in the Review ledger (delivery rule 15)`);
  }
  const rounds = ledgerRounds(text);
  checkRoundOrder(rounds.map((r) => r.round).filter((r) => r !== "fix-check"));
  if (diffHead !== null) for (const r of rounds) checkAncestry(r);
}

function ledgerFindings(text) {
  const json = /```json\n([\s\S]*?)\n```/.exec(text);
  try {
    return JSON.parse(json?.[1] ?? "").findings ?? [];
  } catch {
    failures.push(
      "the `## Review ledger` comment has no json block that parses (REVIEW.md, Measurement)",
    );
    return [];
  }
}

function ledgerRounds(text) {
  const rounds = [];
  for (const l of text.split("\n").filter((l) => l.startsWith("Round "))) {
    const round = /^Round (1|2|fix-check): ([0-9a-f]{40})\s*$/.exec(l);
    if (round === null) {
      failures.push(
        `a ledger line is not "Round <1|2|fix-check>: <full sha>": "${l.slice(0, 60)}"`,
      );
    } else rounds.push({ round: round[1], sha: round[2] });
  }
  return rounds;
}

function checkRoundOrder(order) {
  const twice = (r) => order.filter((x) => x === r).length > 1;
  if (twice("1") || twice("2")) {
    failures.push("the ledger has more than one round 1 or round 2 (REVIEW.md, the cap)");
  } else if (order.length > 0 && order[0] !== "1") {
    failures.push("the ledger's first round is not round 1 (REVIEW.md, the cap)");
  }
}

function checkAncestry({ round, sha }) {
  if (!hasCommit(sha) || !hasCommit(diffHead)) {
    warnings.push(
      `round ${round}'s ${sha.slice(0, 9)} or the head is not in this clone; its ancestry is unchecked`,
    );
  } else if (!git(["merge-base", "--is-ancestor", sha, diffHead], true)) {
    failures.push(`round ${round}'s ${sha.slice(0, 9)} is not an ancestor of the head`);
  }
}

function checkDoneWhen() {
  const number = Number(DELIVERY_BRANCH.exec(branch)[2]);
  const items = checklistItems();
  walkLines(items, api(`issues/${number}`).body ?? "", "Done when", `#${number}`);
  const parent = apiOrNull(`issues/${number}/parent`);
  if (parent !== null && closesLastSubIssue(parent.number, number)) {
    walkLines(items, parent.body ?? "", "Completion conditions", `#${parent.number}`);
  }
}

// why: a checklist line may wrap onto indented lines; a blank or unindented line ends it.
function checklistItems() {
  const checklist = [];
  for (const l of lines) {
    const item = /^\s*- \[([ xX])\] (.*)$/.exec(l);
    if (item !== null) checklist.push({ ticked: item[1] !== " ", text: item[2] });
    else if (/^\s+\S/.test(l) && checklist.length > 0) checklist.at(-1).text += ` ${l.trim()}`;
    else if (l.trim() === "" || !/^\s/.test(l)) checklist.push(null);
  }
  return checklist
    .filter((c) => c !== null)
    .map((c) => ({ ...c, words: new Set(contentWords(c.text)) }));
}

function walkLines(items, text, heading, from) {
  for (const bullet of bullets(text, heading)) {
    const line = matchingLine(items, bullet);
    const quoted = `"${bullet.slice(0, 50)}"`;
    if (line === undefined) {
      failures.push(
        `${from}'s ${heading} line ${quoted} is not a checklist line of the body (coding rule 5)`,
      );
    } else if (!line.ticked) {
      failures.push(`${from}'s ${heading} line ${quoted} is not ticked (coding rule 5)`);
    }
  }
}

function matchingLine(items, bullet) {
  const prose = bullet.replace(/`[^`]*`/g, " ").replace(/\([^)]*\)/g, " ");
  const wanted = [...new Set(contentWords(contentWords(prose).length > 0 ? prose : bullet))];
  const share = (c) => wanted.filter((w) => c.words.has(w)).length / Math.max(1, wanted.length);
  const best = items.reduce((a, c) => (a === undefined || share(c) > share(a) ? c : a), undefined);
  return best !== undefined && share(best) >= MATCH ? best : undefined;
}

// why: in a stack every other open sub-issue must be closed by a PR below this one.
function closesLastSubIssue(parent, number) {
  const open = api(`issues/${parent}/sub_issues`, "-f", "per_page=100")
    .filter((i) => i.state === "open" && i.number !== number)
    .map((i) => i.number);
  if (open.length === 0) return true;
  const stack = apiOrNull(`stacks?pull_request=${prNumber}`) ?? [];
  const members = (stack.find((x) => x.open)?.pull_requests ?? []).map((p) => p.number);
  const below = members.slice(0, Math.max(0, members.indexOf(Number(prNumber))));
  const closed = new Set(below.flatMap((m) => closes(api(`pulls/${m}`).body ?? "")));
  return open.every((n) => closed.has(n));
}

function checkDiff() {
  const counts = lines.find((l) => REVIEW_COUNTS.test(l)) ?? "";
  if (DELIVERY_BRANCH.test(branch) && counts.startsWith("Spec review: skipped.")) {
    failures.push(
      "Spec review is skipped on a branch whose issue is its spec (REVIEW.md, Routing)",
    );
  }
  const kind = option("--kind", args) ?? kindFromGit();
  if (kind !== null) checkKind(kind, counts);
}

// why: null when the diff cannot be read: no SHAs given, or this clone lacks them.
function kindFromGit() {
  if (diffBase === null || diffHead === null) return null;
  if (!hasCommit(diffBase) || !hasCommit(diffHead)) {
    warnings.push(
      "the PR's base or head is not in this clone (git fetch origin); its diff is unchecked",
    );
    return null;
  }
  const mergeBase = git(["merge-base", diffBase, diffHead]).trim();
  if (branch.startsWith("chore/calibrate-reviews-")) checkCalibration(mergeBase);
  return execFileSync(process.execPath, [join(HERE, "diff-kind.mjs"), mergeBase, diffHead], {
    encoding: "utf8",
  }).trim();
}

function checkCalibration(mergeBase) {
  const other = git(["diff", "--name-only", mergeBase, diffHead])
    .split("\n")
    .find((n) => n !== "" && n !== CALIBRATION);
  if (other !== undefined) {
    failures.push(`a calibrate-reviews PR changes ${CALIBRATION} alone; it also changes ${other}`);
  }
}

function checkKind(kind, counts) {
  const routine = ROUTINES.find(([re]) => re.test(branch));
  if (routine !== undefined && kind !== routine[1]) {
    failures.push(`this routine's PR must be ${routine[1]}, and its diff is ${kind}`);
  }
  if (skipsNeededCodeReview(kind, counts, routine)) {
    failures.push(`Code review is skipped on a ${kind} diff (REVIEW.md, Routing)`);
  }
  if (kind === "adr-only" && counts !== "" && !/\bClaims review: skipped\./.test(counts)) {
    warnings.push("a Claims review ran on an adr-only diff, which needs the spec review alone");
  }
}

// why: the review protocol routes a delivery PR's and a routine's lenses; a person's chore PR
// has no review round to route, and merges on the maintainer's say.
function skipsNeededCodeReview(kind, counts, routine) {
  const reviewed = DELIVERY_BRANCH.test(branch) || routine !== undefined;
  const needsCode = ["full", "large", "tests-only"].includes(kind);
  return reviewed && needsCode && /\bCode review: skipped\./.test(counts);
}

function bullets(text, heading) {
  const all = withoutCodeBlocks(text.replace(/\r/g, "")).split("\n");
  const out = [];
  for (const l of section(all, new RegExp(`^## ${heading}\\s*$`)) ?? []) {
    if (/^\s*[-*] /.test(l)) out.push(l.replace(/^\s*[-*] /, ""));
    else if (/^\s+\S/.test(l) && out.length > 0) out[out.length - 1] += ` ${l.trim()}`;
  }
  return out;
}

function contentWords(text) {
  return text
    .replace(/`/g, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => w !== "" && !STOP_WORDS.has(w));
}

function closes(text) {
  return [
    ...text.matchAll(
      /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi,
    ),
  ].map((m) => Number(m[1]));
}

function api(at, ...extra) {
  return JSON.parse(
    execFileSync("gh", ["api", "-X", "GET", `repos/${repository()}/${at}`, ...extra], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

// why: GitHub answers 404 for an issue with no parent and a PR in no stack.
function apiOrNull(at) {
  try {
    return api(at);
  } catch {
    return null;
  }
}

function git(argv, status = false) {
  try {
    const out = execFileSync("git", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return status ? true : out;
  } catch (error) {
    if (status) return false;
    throw error;
  }
}

function hasCommit(sha) {
  return git(["cat-file", "-e", `${sha}^{commit}`], true);
}

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

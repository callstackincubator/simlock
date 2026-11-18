#!/usr/bin/env node
// `node .agents/scripts/review-ledger.mjs <pr> --issue <n> --findings <file.json> --round
// <r>:<sha> [--round <r>:<sha> ...] [--skipped <roles>] [--notes <file>] [--rejected <file>]
// [--incomplete <why>] [--dry-run]`: posts a PR's `## Review ledger` comment
// (docs/internal/REVIEW.md, "Measurement"), writes the PR body's `## Review` section
// (review-section.mjs) and then checks the PR body, so none of them is built or run by hand.
//
// For the section: `--skipped spec,claims` names the reviews the diff's kind left out, `--notes`
// a file of the reports' note lines (`- <role>: ...`), `--rejected` a file of the rejected lines
// (`- <role>: <claim> [incorrect|intentional|nonblocking] — <reason>`), `--incomplete` why
// coverage is not complete. Tokens come from usage.mjs (`n/a` without a transcript).
//
// The comment: one `Round <r>: <full sha>` line per --round, in the order given (<r> is 1, 2 or
// fix-check; a short sha is expanded), then what `review-metrics.mjs --pr <pr> --issue <n>
// --findings <file>` prints, in a code block, then the findings file in a `json` code block,
// then `*Written by an agent.*`. It refuses (exit 2, nothing posted) a sha that is no commit
// after fetching the PR's head, a findings file review-metrics.mjs rejects, and a finding with no
// `round` or a round no --round names; it warns on stderr when a sha is not in the PR head's
// history. It updates the PR's existing comment headed `## Review ledger`, else posts a new one,
// prints `ledger: updated <comment url>` or `ledger: posted <url>`, sets the body's Review section
// through issue-body.mjs, then runs `pr-body-check.mjs <pr>`, prints its output and exits with
// its code. `--dry-run` prints the comment and the section and does none of it. Usage errors exit 2. The repo is GH_REPO, else the origin remote's owner/name.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { option } from "./cli-args.mjs";
import { reviewSection } from "./review-section.mjs";

const USAGE =
  "usage: review-ledger.mjs <pr> --issue <n> --findings <file.json> --round <r>:<sha> [--round ...] [--skipped <roles>] [--notes <file>] [--rejected <file>] [--incomplete <why>] [--dry-run]";
const argv = process.argv.slice(2);
const pr = argv[0];
const issue = option("--issue");
const findingsFile = option("--findings");
const dryRun = argv.includes("--dry-run");
const rounds = argv.flatMap((a, i) => (a === "--round" ? [argv[i + 1] ?? ""] : []));
if (
  !/^\d+$/.test(pr ?? "") ||
  !/^\d+$/.test(issue ?? "") ||
  findingsFile === null ||
  rounds.length === 0
) {
  refuse(USAGE);
}

const here = dirname(fileURLToPath(import.meta.url));
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const nwo =
  process.env.GH_REPO ??
  run("git", ["remote", "get-url", "origin"])
    .trim()
    .replace(/\.git$/, "")
    .replace(/.*[/:]([^/:]+\/[^/]+)$/, "$1");

try {
  run("git", ["fetch", "-q", "origin", `+refs/pull/${pr}/head:refs/review-ledger/${pr}`]);
} catch {
  refuse(`cannot fetch PR #${pr}'s head from origin`);
}
const lines = [];
let wrong = null;
for (const round of rounds) {
  const m = /^(1|2|fix-check):([0-9a-f]{7,40})$/.exec(round);
  if (m === null) {
    wrong = `--round ${round}: want <1|2|fix-check>:<sha>`;
    break;
  }
  const full = spawnSync("git", ["rev-parse", "--verify", "-q", `${m[2]}^{commit}`], {
    encoding: "utf8",
  });
  if (full.status !== 0) {
    wrong = `--round ${round}: ${m[2]} is no commit here, even after fetching PR #${pr}'s head`;
    break;
  }
  const sha = full.stdout.trim();
  const reached = spawnSync("git", [
    "merge-base",
    "--is-ancestor",
    sha,
    `refs/review-ledger/${pr}`,
  ]);
  if (reached.status !== 0) {
    console.error(`review-ledger: warning: round ${m[1]} ${sha} is not in PR #${pr}'s history`);
  }
  lines.push(`Round ${m[1]}: ${sha}`);
}
spawnSync("git", ["update-ref", "-d", `refs/review-ledger/${pr}`]);
if (wrong !== null) refuse(wrong);

let findings;
try {
  findings = JSON.parse(readFileSync(findingsFile, "utf8"));
} catch (error) {
  refuse(`--findings ${findingsFile}: ${error.message}`);
}
const named = new Set(rounds.map((r) => r.split(":")[0]));
for (const f of Array.isArray(findings.findings) ? findings.findings : []) {
  if (f.round === undefined) refuse(`finding ${f.id} has no round`);
  if (!named.has(String(f.round))) {
    refuse(`finding ${f.id} names round ${f.round}, which no --round gives`);
  }
}
const metrics = spawnSync(
  "node",
  [join(here, "review-metrics.mjs"), "--pr", pr, "--issue", issue, "--findings", findingsFile],
  { encoding: "utf8" },
);
if (metrics.status !== 0) {
  const why = metrics.stderr.split("\n").find((l) => /^\w*Error: /.test(l)) ?? metrics.stderr;
  refuse(`review-metrics.mjs rejected the findings: ${why.trim()}`);
}

const comment = [
  "## Review ledger",
  lines.join("\n"),
  `\`\`\`\n${metrics.stdout.trim()}\n\`\`\``,
  `\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``,
  "*Written by an agent.*",
].join("\n\n");
const usage = spawnSync("node", [join(here, "usage.mjs")], { encoding: "utf8" });
const fileText = (name) => (option(name) === null ? "" : readFileSync(option(name), "utf8"));
let section;
try {
  section = reviewSection({
    findings: Array.isArray(findings.findings) ? findings.findings : [],
    rounds: rounds.map((r) => r.split(":")[0]),
    skipped: (option("--skipped") ?? "").split(",").filter(Boolean),
    notes: fileText("--notes"),
    rejected: fileText("--rejected"),
    incomplete: option("--incomplete"),
    tokens: /tokens=([\d.]+)M/.exec(usage.stdout ?? "")?.[1],
    runs: metrics.stdout.split("\n")[0].trim(),
  });
} catch (error) {
  refuse(error.message);
}
if (dryRun) {
  console.log(`${comment}\n\n## Review\n\n${section}`);
  process.exit(0);
}

// why: `gh api --paginate` follows Link headers to numeric-ID repository URLs, which a cloud
// session's GitHub proxy refuses, so pages are requested by number.
let existing;
for (let page = 1; existing === undefined; page += 1) {
  const batch = JSON.parse(
    run("gh", [
      "api",
      "-X",
      "GET",
      `repos/${nwo}/issues/${pr}/comments`,
      "-f",
      "per_page=100",
      "-f",
      `page=${page}`,
    ]),
  );
  existing = batch.find((c) => /^## Review ledger\s*$/m.test(c.body ?? ""));
  if (batch.length < 100) break;
}
const dir = mkdtempSync(join(tmpdir(), "review-ledger-"));
try {
  const payload = join(dir, "comment.json");
  writeFileSync(payload, JSON.stringify({ body: comment }));
  const [method, path] =
    existing === undefined
      ? ["POST", `issues/${pr}/comments`]
      : ["PATCH", `issues/comments/${existing.id}`];
  const posted = JSON.parse(
    run("gh", ["api", "-X", method, `repos/${nwo}/${path}`, "--input", payload]),
  );
  console.log(`ledger: ${existing === undefined ? "posted" : "updated"} ${posted.html_url}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const sectionDir = mkdtempSync(join(tmpdir(), "review-section-"));
try {
  const file = join(sectionDir, "review.md");
  writeFileSync(file, `${section}\n`);
  process.stdout.write(
    run("node", [join(here, "issue-body.mjs"), pr, "--pr", "set-section", "Review", file]),
  );
} finally {
  rmSync(sectionDir, { recursive: true, force: true });
}

const check = spawnSync("node", [join(here, "pr-body-check.mjs"), pr], { encoding: "utf8" });
process.stdout.write(check.stdout);
process.stderr.write(check.stderr);
process.exit(check.status ?? 1);

function refuse(message) {
  console.error(message.startsWith("usage:") ? message : `review-ledger: ${message}`);
  process.exit(2);
}

#!/usr/bin/env node
// `node .agents/scripts/replay-freeze.mjs --pr <M> --round <1|2|fix-check> --head <sha> --base <sha>
// [--previous <sha>] [--issue <N>] [--escaped <file.json>] [--replace-truth]`: freezes one review snapshot of a PR so review-replay.sh can
// review it again later, with today's or tomorrow's agents, and review-score.mjs can score the
// result against what the real review found.
//
// Writes .agents/replay/<M>.json (one file per PR, one entry per round): the SHAs and the real
// review's measured runs for the round as the baseline. Each SHA must be reachable from
// refs/pull/<M>/head or from the PR's base history; the script then pins them on origin as
// refs/replay/<M>/<round>/{head,base,previous}, a ref namespace no branch or tag shows, so the
// snapshot survives branch deletion and GC on every machine.
//
// The ground truth, the PR's `## Review ledger` findings (every outcome kept: `fixed` and `open`
// are the defects, the others known non-defects), goes to origin too, as the blob
// refs/replay/<M>/truth, and never into the checkout: the first replay's coordinator opened the
// snapshot file and read the answers before its lenses ran. review-score.mjs fetches the blob.
//
// --escaped names a file kept outside the checkout: the bugs the round's review let through,
// `[{"bug": <issue>, "fix": "<commit>", "places": [{"file": "<path>", "start": <n>, "end": <n>}],
// "note": "<optional>"}]`. A place is the smallest block of the round's head that holds the
// defect. The fix must be a local commit, every place must exist at the head, and one place of
// each bug must overlap a line the reviewed diff adds; anything else is refused and nothing is
// written or pushed. They go into the truth blob under `escaped`, tagged with the round; the
// blob keeps the entries it has for other rounds, and without --escaped this round's too.
//
// Git refuses to replace a pinned blob. A freeze whose truth differs from the one on origin is
// refused, nothing written or pushed, unless --replace-truth is given: the script then deletes
// refs/replay/<M>/truth and pins the new blob, built from the stored one first. Never delete
// that ref by hand: a freeze that finds none starts from an empty truth.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { option } from "./cli-args.mjs";

const pr = option("--pr");
const round = option("--round");
const head = option("--head");
const base = option("--base");
const previous = option("--previous");
const issue = option("--issue");
const escapedFile = option("--escaped");
if (!/^\d+$/.test(pr ?? "") || !round || !head || !base) {
  console.error(
    "usage: replay-freeze.mjs --pr <M> --round <1|2|fix-check> --head <sha> --base <sha> [--previous <sha>] [--issue <N>] [--escaped <file.json>] [--replace-truth]",
  );
  process.exit(64);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const git = (...a) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const gh = (...a) => execFileSync("gh", a, { cwd: root, encoding: "utf8" });

git("fetch", "-q", "origin", `+refs/pull/${pr}/head:refs/replay-freeze/${pr}`);
const full = {};
for (const [name, sha] of Object.entries({ head, base, previous })) {
  if (!sha) continue;
  try {
    full[name] = git("rev-parse", "--verify", `${sha}^{commit}`);
  } catch {
    console.error(`${name} ${sha} is not a local commit; fetch the PR below in the stack first`);
    process.exit(65);
  }
}
try {
  git("merge-base", "--is-ancestor", full.head, `refs/replay-freeze/${pr}`);
} catch {
  console.error(`head ${head} is not an ancestor of refs/pull/${pr}/head`);
  process.exit(65);
}
git("update-ref", "-d", `refs/replay-freeze/${pr}`);
const escaped =
  escapedFile === null ? null : escapedBugs(JSON.parse(readFileSync(escapedFile, "utf8")));

const nwo =
  process.env.GH_REPO ??
  git("remote", "get-url", "origin")
    .replace(/\.git$/, "")
    .replace(/.*[/:]([^/:]+\/[^/]+)$/, "$1");
const comments = JSON.parse(
  gh("api", "-X", "GET", `repos/${nwo}/issues/${pr}/comments`, "-f", "per_page=100"),
);
let findings = null;
const recordedRounds = {};
for (const c of comments) {
  if (!/^## Review ledger/m.test(c.body ?? "")) continue;
  const m = c.body.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (m) findings = JSON.parse(m[1]).findings;
  for (const [, r, sha] of c.body.matchAll(/^Round (\S+): ([0-9a-f]{7,40})/gm))
    recordedRounds[r] = sha;
}
if (
  recordedRounds[round] &&
  !recordedRounds[round].startsWith(head.slice(0, 7)) &&
  !head.startsWith(recordedRounds[round].slice(0, 7))
) {
  console.error(
    `the ledger comment says round ${round} reviewed ${recordedRounds[round]}, not ${head}`,
  );
  process.exit(65);
}
if (findings === null)
  console.error(
    `PR #${pr} has no Review ledger comment with a findings block; ground truth is empty`,
  );

let baseline = null;
try {
  const metrics = JSON.parse(
    execFileSync(
      "node",
      [
        join(root, ".agents/scripts/review-metrics.mjs"),
        "--pr",
        pr,
        ...(issue ? ["--issue", issue] : []),
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
  // why: --issue also brings the runs of a closed PR that held the same issue before this one.
  const runs = metrics.runs.filter(
    (r) => r.stage === "review" && r.round === round && (r.pr === pr || r.pr === "-"),
  );
  // why: a PR whose review left no transcript on this machine has an unknown baseline, not a free one.
  const sum = (k) =>
    runs.length === 0 || runs.some((r) => r[k] === null)
      ? null
      : runs.reduce((a, r) => a + (r[k] ?? 0), 0);
  baseline = {
    runs: runs.length,
    seconds: sum("seconds"),
    costUsd: sum("costUsd"),
    lenses: runs.map((r) => `${r.role}/${r.lens}:${r.models.join("+")}`),
  };
} catch {}

const truthRef = `refs/replay/${pr}/truth`;
const pinned = git("ls-remote", "origin", truthRef).split(/\s/)[0] || null;
const stored = pinned === null ? null : storedTruth();
const allEscaped =
  escaped === null
    ? (stored?.escaped ?? [])
    : [...(stored?.escaped ?? []).filter((e) => e.round !== round), ...escaped];
let blob = null;
if (findings !== null || allEscaped.length > 0) {
  // why: a blob with no `escaped` key is what the earlier snapshots hold, so a freeze that adds
  // no escaped bug writes the same bytes and replaces nothing.
  const truth = {
    pr: Number(pr),
    findings: findings ?? stored?.findings ?? [],
    ...(allEscaped.length === 0 ? {} : { escaped: allEscaped }),
  };
  blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: JSON.stringify(truth, null, 2) + "\n",
    encoding: "utf8",
  }).trim();
}
const replaces = pinned !== null && blob !== null && blob !== pinned;
if (replaces && !process.argv.includes("--replace-truth")) {
  console.error(
    `${truthRef} on origin holds ${stored.findings?.length ?? 0} findings and ${stored.escaped?.length ?? 0} escaped bugs, and this freeze would pin ${findings?.length ?? stored.findings?.length ?? 0} and ${allEscaped.length}. Git refuses to replace a pinned blob: run again with --replace-truth, and never delete the ref by hand.`,
  );
  process.exit(65);
}

const dir = join(root, ".agents/replay");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${pr}.json`);
const snapshot = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : { pr: Number(pr), issue: issue ? Number(issue) : null, rounds: {} };
snapshot.rounds[round] = { ...full, frozenAt: new Date().toISOString(), baseline };
delete snapshot.findings;
writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");

const refs = Object.entries(full).map(([name, sha]) => `${sha}:refs/replay/${pr}/${round}/${name}`);
if (blob !== null && blob !== pinned) refs.push(`${blob}:${truthRef}`);
if (replaces) git("push", "-q", "origin", `:${truthRef}`);
try {
  git("push", "-q", "origin", ...refs);
} catch (error) {
  if (replaces)
    console.error(
      `the old truth is deleted and the new one is not pinned: run \`git push origin ${blob}:${truthRef}\``,
    );
  throw error;
}
console.log(
  `frozen PR #${pr} round ${round}: ${Object.entries(full)
    .map(([k, v]) => `${k} ${v.slice(0, 8)}`)
    .join(
      ", ",
    )}; ${findings?.length ?? 0} ground-truth findings, ${allEscaped.length} escaped bugs; pinned ${refs.length} refs on origin; ${file}`,
);

function storedTruth() {
  git("fetch", "-q", "origin", `+${truthRef}:${truthRef}`);
  return JSON.parse(git("cat-file", "-p", truthRef));
}

function escapedBugs(list) {
  if (!Array.isArray(list)) refuseEscaped("the file is not a list");
  const fork = git("merge-base", full.base, full.head);
  return list.map((entry) => escapedBug(entry, fork));
}

function refuseEscaped(why) {
  console.error(
    `--escaped: ${why}. Each entry is {"bug": <issue>, "fix": "<commit>", "places": [{"file": "<path at the head>", "start": <first line>, "end": <last line>}]}`,
  );
  process.exit(65);
}

function escapedBug(entry, fork) {
  const places = Array.isArray(entry.places) ? entry.places : [];
  if (!Number.isInteger(entry.bug) || typeof entry.fix !== "string" || places.length === 0)
    refuseEscaped(`${JSON.stringify(entry)} lacks a bug, a fix or a place`);
  for (const place of places) checkPlace(entry.bug, place);
  const reviewed = places.some(({ file, start, end }) =>
    addedLines(fork, file).some(([from, to]) => from <= end && to >= start),
  );
  if (!reviewed)
    refuseEscaped(
      `bug #${entry.bug}: no place overlaps a line the diff ${fork.slice(0, 8)}..${full.head.slice(0, 8)} adds, so this review never saw the defect`,
    );
  return {
    bug: entry.bug,
    fix: fixCommit(entry),
    round,
    places: places.map(({ file, start, end }) => ({ file, start, end })),
    ...(typeof entry.note === "string" ? { note: entry.note } : {}),
  };
}

function fixCommit(entry) {
  try {
    return git("rev-parse", "--verify", `${entry.fix}^{commit}`);
  } catch {
    return refuseEscaped(
      `bug #${entry.bug}: fix ${entry.fix} is not a local commit; fetch origin/main`,
    );
  }
}

function checkPlace(bug, { file, start, end }) {
  let lines;
  try {
    lines = git("show", `${full.head}:${file}`).split("\n").length;
  } catch {
    refuseEscaped(`bug #${bug}: ${file} is not a file at head ${full.head.slice(0, 8)}`);
  }
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 1 && start <= end))
    refuseEscaped(`bug #${bug}: ${file} needs start and end line numbers, start first`);
  if (end > lines) refuseEscaped(`bug #${bug}: ${file} has ${lines} lines at the head, not ${end}`);
}

function addedLines(fork, file) {
  const diff = git("diff", "-U0", fork, full.head, "--", file);
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => [Number(m[1]), Number(m[1]) + Number(m[2] ?? 1) - 1])
    .filter(([from, to]) => to >= from);
}

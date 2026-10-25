#!/usr/bin/env node
// `node .agents/scripts/replay-freeze.mjs --pr <M> --round <1|2|fix-check> --head <sha> --base <sha>
// [--previous <sha>] [--issue <N>]`: freezes one review snapshot of a PR so review-replay.sh can
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
if (!/^\d+$/.test(pr ?? "") || !round || !head || !base) {
  console.error(
    "usage: replay-freeze.mjs --pr <M> --round <1|2|fix-check> --head <sha> --base <sha> [--previous <sha>] [--issue <N>]",
  );
  process.exit(64);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
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
  const runs = metrics.runs.filter((r) => r.stage === "review" && r.round === round);
  const sum = (k) =>
    runs.some((r) => r[k] === null) ? null : runs.reduce((a, r) => a + (r[k] ?? 0), 0);
  baseline = {
    runs: runs.length,
    seconds: sum("seconds"),
    costUsd: sum("costUsd"),
    lenses: runs.map((r) => `${r.role}/${r.lens}:${r.models.join("+")}`),
  };
} catch {}

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
if (findings !== null) {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: JSON.stringify({ pr: Number(pr), findings }, null, 2) + "\n",
    encoding: "utf8",
  }).trim();
  refs.push(`${blob}:refs/replay/${pr}/truth`);
}
git("push", "-q", "origin", ...refs);
console.log(
  `frozen PR #${pr} round ${round}: ${Object.entries(full)
    .map(([k, v]) => `${k} ${v.slice(0, 8)}`)
    .join(
      ", ",
    )}; ${findings?.length ?? 0} ground-truth findings; pinned ${refs.length} refs on origin; ${file}`,
);

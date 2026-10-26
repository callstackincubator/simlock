#!/usr/bin/env node
// `node .agents/scripts/ci-triage.mjs <pr>`: sorts a PR's CI failures before anyone starts a fix
// run, so a failure the PR did not cause costs a rerun or a stack sync, not an implementer.
//
// For each failed test ci-failures.mjs reports on the PR's branch, one line `<class> <test>`:
//
//   flaky    an open `flaky-test` issue names the test's file (testing rule 5): rerun the job
//   base     the same test failed in the newest finished run on the PR's base branch: the
//            branch inherited it; sync the stack (stack-sync.sh) and let CI run again
//   reach    the test file, or a source file in its directory, is in the PR's diff: a fix run
//   unknown  none of the above: rerun the failed jobs once; a second failure gets a fix run
//
// A failed job whose log names no test (lint, typecheck, format) prints as `<class> job <name>`
// followed by up to 8 indented lines from its log: the lines naming a file:line or an error, else
// its last 3 lines (none for Quality and Console, which only sum up other jobs); nobody needs
// `gh run view --log-failed` by hand.
//
// Ends with `rerun <run id>` lines for the runs whose failures are all flaky or unknown, and
// `none` when nothing failed. Exits 0, or 3 when the result is stale: when a workflow's newest
// finished run on the branch is for a commit that is not the PR's head (a push cancels the run
// before it, so the head's own run may not have finished), one line `stale: run <id> is <sha7>,
// head is <sha7>; checks for the head are <pending|missing>` comes first, and the lines after it
// describe that older commit. The repo is GH_REPO, else the origin remote's owner/name.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pr = process.argv[2];
if (pr === undefined || !/^\d+$/.test(pr)) {
  console.error("usage: ci-triage.mjs <pr>");
  process.exit(2);
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
const api = (path, ...extra) =>
  JSON.parse(run("gh", ["api", "-X", "GET", `repos/${nwo}/${path}`, ...extra]));

function failures(args) {
  const out = run("node", [join(here, "ci-failures.mjs"), ...args]);
  const runs = [];
  for (const line of out.split("\n")) {
    const head = /^(.+) run (\d+) at (\w+)$/.exec(line);
    if (head) runs.push({ workflow: head[1], id: head[2], tests: [] });
    else if (/^\s+\S/.test(line) && runs.length > 0) runs[runs.length - 1].tests.push(line.trim());
  }
  return runs;
}
// why: GitHub's stored logs spell the escape byte as the two characters `^[`.
const ANSI = new RegExp(`(?:${String.fromCharCode(27)}|\\^\\[)\\[[0-9;]*m`, "g");
const testFile = (test) =>
  /^((?:e2e|src|ui)\/[\w./-]+\.(?:test|spec)\.tsx?)/.exec(test)?.[1] ?? null;

const pull = api(`pulls/${pr}`);
const stale = staleRuns();
for (const line of stale) console.log(line);
const mine = failures([pr]);
if (mine.length === 0) {
  console.log("none");
  process.exit(stale.length > 0 ? 3 : 0);
}
const onBase = new Set(failures(["--branch", pull.base.ref]).flatMap((r) => r.tests));
const flakyIssues = api(
  "issues",
  "-f",
  "labels=flaky-test",
  "-f",
  "state=open",
  "-f",
  "per_page=100",
);
const changed = new Set();
for (let page = 1; page <= 3; page += 1) {
  const files = api(`pulls/${pr}/files`, "-f", "per_page=100", "-f", `page=${page}`);
  for (const f of files) changed.add(f.filename);
  if (files.length < 100) break;
}
const reached = (file) => {
  if (file === null) return false;
  if (changed.has(file)) return true;
  const dir = dirname(file);
  return [...changed].some((f) => dirname(f) === dir && /\.tsx?$/.test(f));
};

const reruns = [];
for (const r of mine) {
  let needsFix = false;
  for (const test of r.tests) {
    const file = testFile(test);
    const base = file === null ? "" : file.split("/").pop();
    let cls = "unknown";
    if (flakyIssues.some((i) => base !== "" && `${i.title}\n${i.body ?? ""}`.includes(base)))
      cls = "flaky";
    else if (onBase.has(test)) cls = "base";
    else if (reached(file)) cls = "reach";
    if (cls === "reach" || cls === "base") needsFix = true;
    console.log(`${cls} ${test} (${r.workflow} run ${r.id})`);
    if (test.startsWith("job ")) for (const l of excerpt(r.id, test)) console.log(`  ${l}`);
  }
  if (!needsFix) reruns.push(r.id);
}
for (const id of reruns) console.log(`rerun ${id}`);
process.exit(stale.length > 0 ? 3 : 0);

// why: ci-failures.mjs reads only a workflow's newest run that ended in success or failure, so
// while the head's run is pending or was cancelled it reports an older commit as if current.
function staleRuns() {
  const listed = api(
    "actions/runs",
    "-f",
    `branch=${pull.head.ref}`,
    "-f",
    "per_page=100",
  ).workflow_runs;
  const head = pull.head.sha;
  const finished = (r) => r.conclusion === "success" || r.conclusion === "failure";
  const newest = new Map();
  for (const r of listed.filter(finished)) {
    const seen = newest.get(r.name);
    if (seen === undefined || r.created_at > seen.created_at) newest.set(r.name, r);
  }
  // why: a run GitHub skipped on the head (Issue state skips most events) is that workflow's
  // whole answer for the head, so an older run of it is not stale.
  const settled = (name) =>
    listed.some(
      (r) =>
        r.name === name &&
        r.head_sha === head &&
        r.status === "completed" &&
        r.conclusion !== "cancelled",
    );
  return [...newest.values()]
    .filter((r) => r.head_sha !== head && !settled(r.name))
    .map((r) => {
      const pending = listed.some(
        (x) => x.name === r.name && x.head_sha === head && x.status !== "completed",
      );
      return `stale: run ${r.id} is ${r.head_sha.slice(0, 7)}, head is ${head.slice(0, 7)}; checks for the head are ${pending ? "pending" : "missing"}`;
    });
}

function excerpt(id, test) {
  const job = /^job (.+?)(?: \(log unavailable: .*\))?$/.exec(test)[1];
  if (/^(Quality|Console)$/.test(job)) return [];
  let log;
  try {
    log = run("gh", ["run", "view", id, "--log-failed"]);
  } catch {
    return [];
  }
  const lines = log
    .split("\n")
    .filter((l) => l.startsWith(`${job}\t`))
    .map((l) =>
      l
        .replace(ANSI, "")
        .replace(/^[^\t]*\t[^\t]*\t\uFEFF?\S+Z ?/, "")
        .trimEnd(),
    )
    .filter(
      (l) =>
        l.trim() !== "" &&
        !/Process completed with exit code|ELIFECYCLE|^##\[(?:end)?group\]/.test(l),
    );
  const named = lines.filter((l) =>
    /(?:^|[\s[(])[\w./-]+\.(?:[cm]?[jt]sx?|mdx?|json|sh|ya?ml)(?::\d|\(\d|: )|\berror\b|^\s*[×✖]/i.test(
      l,
    ),
  );
  return (named.length > 0 ? named : lines.slice(-3)).slice(0, 8).map((l) => l.trim());
}

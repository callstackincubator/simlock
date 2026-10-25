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
// Ends with `rerun <run id>` lines for the runs whose failures are all flaky or unknown, and
// `none` when nothing failed. The repo is GH_REPO, else the origin remote's owner/name.
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
const testFile = (test) =>
  /^((?:e2e|src|ui)\/[\w./-]+\.(?:test|spec)\.tsx?)/.exec(test)?.[1] ?? null;

const pull = api(`pulls/${pr}`);
const mine = failures([pr]);
if (mine.length === 0) {
  console.log("none");
  process.exit(0);
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
  }
  if (!needsFix) reruns.push(r.id);
}
for (const id of reruns) console.log(`rerun ${id}`);

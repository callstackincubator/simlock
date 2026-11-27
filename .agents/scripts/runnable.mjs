#!/usr/bin/env node
// `node .agents/scripts/runnable.mjs <feature> [--world <f>]`: which of a feature's tasks the
// deliver skill may start now (delivery rule 1), so nobody reads the Depends on by hand. It
// prints the Depends on facts of the open sub-issues, each as `B <n> Depends on: ...` or `N
// ...` (as spec-lint.mjs does): a number that does not exist and a cycle block; a closed issue
// is a note; an open issue outside the feature is `depends-outside #<d> (open, feature #<m>)`.
// Then `chain <k> of <t> tasks` (the longest Depends on path, counted in tasks, over every
// sub-issue), one `waiting #<t>: <why>` line per open task it leaves out, and last `runnable:
// #<a> #<b>` (or `runnable: none`).
//
// A task is runnable when it is open, `task:ready` and unassigned, and every issue under its
// Depends on is closed, or is a sub-issue of this feature with an open PR out of draft that
// closes it. Exit 1 on a cycle or a missing number, 2 on a usage error. `--world <f>` reads
// the issues from a JSON file (see spec-body.mjs) instead of GitHub. The repo is GH_REPO, else
// the origin remote.
//
// `node .agents/scripts/runnable.mjs --bug <n> [--world <f>]`: whether an unattended run may
// start on bug <n> now. It prints `run` and exits 0, or `held: <why>` and exits 1. The bug
// itself must be open, unassigned, and `bug:new` or `bug:ready`. Another bug holds it only on
// a live claim: an open PR from a `bug/<m>` branch of this repository whose issue #<m> is open
// and assigned. A fork's PR, a PR whose issue is closed and a parked PR (issue unassigned)
// hold nothing. With `--world`, the open PRs are its `pulls`: `[{ number, head, fork }]`.
import { execFileSync } from "node:child_process";

import { dependsOn, graph, issues, printFinding, readWorld } from "./spec-body.mjs";
import { option, repository } from "./cli-args.mjs";

const args = process.argv.slice(2);
const bug = args.includes("--bug");
const feature = Number(bug ? option("--bug") : args[0]);
if (!/^\d+$/.test((bug ? option("--bug") : args[0]) ?? "")) {
  console.error("usage: runnable.mjs <feature> [--world <f>] | --bug <n> [--world <f>]");
  process.exit(2);
}
const world = readWorld(option("--world"));
if (bug) {
  const why = bugHold(feature);
  console.log(why === null ? "run" : `held: ${why}`);
  process.exit(why === null ? 0 : 1);
}

const root = issues([feature], world).get(feature);
if (root === undefined) {
  console.error(`runnable: #${feature} does not exist`);
  process.exit(2);
}
const tasks = [...issues(root.subIssues, world).values()];
const open = tasks.filter((t) => t.state === "open");
const known = issues(
  open.flatMap((t) => dependsOn(t.body)),
  world,
);
const result = graph(tasks, known);
for (const f of result.findings) printFinding(f);
if (result.chain !== null) console.log(`chain ${result.chain} of ${tasks.length} tasks`);

const subs = new Map(tasks.map((t) => [t.number, t]));
const ready = [];
for (const task of open) {
  const why = blocker(task);
  if (why === null) ready.push(`#${task.number}`);
  else console.log(`waiting #${task.number}: ${why}`);
}
console.log(`runnable: ${result.cycle === null && ready.length > 0 ? ready.join(" ") : "none"}`);
process.exit(result.findings.some((f) => f.level === "B") ? 1 : 0);

function blocker(task) {
  if (!task.labels.includes("task:ready")) {
    return `labelled ${task.labels.filter((l) => l.startsWith("task:")).join(", ") || "no task label"}`;
  }
  if (task.assignees.length > 0) return `assigned to ${task.assignees.join(", ")}`;
  const waits = dependsOn(task.body).filter((d) => !settled(d));
  return waits.length === 0 ? null : `on ${waits.map(describe).join(", ")}`;
}

function settled(dep) {
  const target = subs.get(dep) ?? known.get(dep);
  if (target === undefined) return false;
  if (target.state === "closed") return true;
  return subs.has(dep) && target.prs.some((p) => !p.draft);
}

function describe(dep) {
  const target = subs.get(dep) ?? known.get(dep);
  if (target === undefined) return `#${dep} (does not exist)`;
  if (!subs.has(dep)) return `#${dep} (open, outside this feature)`;
  return `#${dep} (${target.prs.length === 0 ? "no PR" : "PR in draft"})`;
}

function bugHold(n) {
  const claims = openPulls()
    .map((p) => ({ ...p, issue: Number(/^bug\/(\d+)$/.exec(p.head)?.[1]) }))
    .filter((p) => !p.fork && !Number.isNaN(p.issue));
  const known = issues([n, ...claims.map((p) => p.issue)], world);
  const self = known.get(n);
  if (self === undefined) return `#${n} does not exist`;
  if (self.state !== "open") return `#${n} is closed`;
  if (self.assignees.length > 0) return `#${n} is assigned to ${self.assignees.join(", ")}`;
  if (!self.labels.some((l) => l === "bug:new" || l === "bug:ready")) {
    const state = self.labels.filter((l) => /^\w+:/.test(l)).join(", ") || "no state label";
    return `#${n} carries ${state}, not bug:new or bug:ready`;
  }
  for (const pull of claims) {
    const other = known.get(pull.issue);
    if (other === undefined || other.state !== "open" || other.assignees.length === 0) continue;
    return `PR #${pull.number} (${pull.head}) is open and #${pull.issue} is assigned to ${other.assignees.join(", ")}; one bug at a time, run again when it merges`;
  }
  return null;
}

function openPulls() {
  if (world !== null) return world.pulls ?? [];
  const nwo = repository();
  const all = [];
  for (let page = 1; ; page++) {
    const batch = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "-X",
          "GET",
          `repos/${nwo}/pulls`,
          "-f",
          "state=open",
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    for (const p of batch) {
      // why: a fork that was deleted leaves `head.repo` null; that PR is still a fork's.
      const from = p.head.repo?.full_name ?? "";
      all.push({
        number: p.number,
        head: p.head.ref,
        fork: from.toLowerCase() !== nwo.toLowerCase(),
      });
    }
    if (batch.length < 100) return all;
  }
}

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
import { dependsOn, graph, issues, printFinding, readWorld } from "./spec-body.mjs";
import { option } from "./cli-args.mjs";

const args = process.argv.slice(2);
const feature = Number(args[0]);
if (!/^\d+$/.test(args[0] ?? "")) {
  console.error("usage: runnable.mjs <feature> [--world <f>]");
  process.exit(2);
}
const world = readWorld(option("--world"));

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

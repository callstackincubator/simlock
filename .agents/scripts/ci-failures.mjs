#!/usr/bin/env node
// `node .agents/scripts/ci-failures.mjs <pr | --branch <name>>`: the tests that failed in the
// newest finished run of each workflow on the PR's branch, or on the named branch. A push cancels the run before it, so while pushes come
// faster than CI the head's own checks stay pending and only an older run shows a failure.
//
// Prints `none`, or for each workflow whose newest finished run failed: `<workflow> run <id> at
// <sha>`, then one indented line per failed test (`<file> > <title>`), or per failed job when
// its log names no test or GitHub refuses the log.
import { execFileSync } from "node:child_process";

const pr = process.argv[2];
if (pr === undefined || (pr === "--branch" && process.argv[3] === undefined)) {
  console.error("usage: ci-failures.mjs <pr | --branch <name>>");
  process.exit(2);
}
const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
// GitHub's stored logs spell the escape byte as the two characters `^[`.
const ANSI = new RegExp(`(?:${String.fromCharCode(27)}|\\^\\[)\\[[0-9;]*m`, "g");

const branch =
  pr === "--branch"
    ? process.argv[3]
    : JSON.parse(gh("pr", "view", pr, "--json", "headRefName")).headRefName;
const runs = JSON.parse(
  gh(
    "run",
    "list",
    "--branch",
    branch,
    "--limit",
    "100",
    "--json",
    "databaseId,workflowName,headSha,conclusion,createdAt",
  ),
);

const newest = new Map();
for (const run of runs) {
  if (run.conclusion !== "success" && run.conclusion !== "failure") continue;
  const seen = newest.get(run.workflowName);
  if (seen === undefined || run.createdAt > seen.createdAt) newest.set(run.workflowName, run);
}

const failed = [...newest.values()].filter((run) => run.conclusion === "failure");
if (failed.length === 0) console.log("none");
for (const run of failed) {
  const id = String(run.databaseId);
  console.log(`${run.workflowName} run ${id} at ${run.headSha.slice(0, 7)}`);
  const tests = new Set();
  let log = "";
  let refused = null;
  try {
    log = gh("run", "view", id, "--log-failed");
  } catch (error) {
    refused = String(error.stderr ?? error.message)
      .trim()
      .split("\n")[0];
  }
  for (const line of log.split("\n")) {
    const plain = line.replace(ANSI, "");
    if (!/ FAIL |\) \[[a-z]+\] › /.test(plain)) continue;
    const test = /(?:e2e|src|ui)\/[\w./-]+\.(?:test|spec)\.tsx?.*/.exec(plain);
    if (test !== null) tests.add(test[0].trim());
  }
  const lines =
    tests.size > 0
      ? [...tests]
      : JSON.parse(gh("run", "view", id, "--json", "jobs"))
          .jobs.filter((job) => job.conclusion === "failure")
          .map(
            (job) => `job ${job.name}${refused === null ? "" : ` (log unavailable: ${refused})`}`,
          );
  for (const line of lines) console.log(`  ${line}`);
}

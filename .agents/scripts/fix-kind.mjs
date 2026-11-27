#!/usr/bin/env node
// `node .agents/scripts/fix-kind.mjs <previous> <head> --base <sha> --findings <file.json>`: says
// whether the commits after the last reviewed one need a fix-check (the deliver skill, step 2).
// <previous> is the commit the last check reviewed, <base> the `base` line of pr-shas.sh,
// <file.json> the PR's findings file. The PR's patch at a commit is `git diff --binary -U3` from
// its merge base with <base>, without the `index` lines and the numbers of each `@@` line.
//
// Exit 0, one line `verified by: script (...)`: no finding is `open`, <previous> is an ancestor
// of <head>, and the patch is the same text at both commits: a merge of the base that only
// moved the PR's hunks to other line numbers.
// Exit 1, one `fix-kind: <what>: <why>` line each: an open finding, a rebase, each file whose
// part of the patch differs (a changed, moved or re-indented line, a changed line of context, a
// mode, a rename). The fix gets its fix-check. Exit 2: usage, or a commit this clone lacks.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { option } from "./cli-args.mjs";

const argv = process.argv.slice(2);
const [previousArg, headArg] = argv;
const baseArg = option("--base");
const findingsFile = option("--findings");
if (
  previousArg === undefined ||
  headArg === undefined ||
  previousArg.startsWith("--") ||
  headArg.startsWith("--") ||
  baseArg === null ||
  findingsFile === null
) {
  refuse("usage: fix-kind.mjs <previous> <head> --base <sha> --findings <file.json>");
}
const git = (...args) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
const [previous, head, base] = [previousArg, headArg, baseArg].map((name) => {
  const found = spawnSync("git", ["rev-parse", "--verify", "-q", `${name}^{commit}`], {
    encoding: "utf8",
  });
  if (found.status !== 0) refuse(`fix-kind: ${name} is no commit here: git fetch origin`);
  return found.stdout.trim();
});
let findings;
try {
  findings = JSON.parse(readFileSync(findingsFile, "utf8")).findings ?? [];
} catch (error) {
  refuse(`fix-kind: --findings ${findingsFile}: ${error.message}`);
}

const reasons = findings
  .filter((f) => f.outcome === "open")
  .map((f) => `${f.id}: the finding is open, and its fix needs the check`);
if (spawnSync("git", ["merge-base", "--is-ancestor", previous, head]).status !== 0) {
  reasons.push(`${previous.slice(0, 9)}: not an ancestor of the head; a rebase needs the check`);
}
const before = patch(previous);
const after = patch(head);
if (before.text !== after.text) {
  const differs = [...new Set([...before.files.keys(), ...after.files.keys()])].filter(
    (path) => before.files.get(path) !== after.files.get(path),
  );
  for (const path of differs.length > 0 ? differs : ["the PR"]) {
    reasons.push(`${path}: its part of the PR's patch changed`);
  }
}
if (reasons.length > 0) {
  for (const reason of reasons) console.log(`fix-kind: ${reason}`);
  process.exit(1);
}
console.log(
  `verified by: script (fix-kind ${previous.slice(0, 9)}..${head.slice(0, 9)}: the PR's patch is the same)`,
);

// why: `text` decides, so a header this cannot split into files still counts; `files` only
// names what differs.
function patch(commit) {
  const fork = git("merge-base", commit, base).trim();
  const lines = git(
    "diff",
    "--binary",
    "-U3",
    "--no-renames",
    "--no-color",
    "--no-ext-diff",
    fork,
    commit,
  )
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@"));
  const files = new Map();
  let path = null;
  for (const line of lines) {
    path = /^diff --git a\/(.*) b\/\1$/.exec(line)?.[1] ?? path;
    if (path !== null) files.set(path, `${files.get(path) ?? ""}${line}\n`);
  }
  return { text: lines.join("\n"), files };
}

function refuse(message) {
  console.error(message);
  process.exit(2);
}

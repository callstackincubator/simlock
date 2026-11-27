#!/usr/bin/env node
// `node .agents/scripts/fix-kind.mjs <previous> <head> --base <sha> --findings <file.json>`: says
// whether the commits after the last reviewed one need a fix-check (the deliver skill, step 2).
// <previous> is the commit the last check reviewed, <base> the `base` line of pr-shas.sh,
// <file.json> the PR's findings file. The PR's diff at a commit is `git diff -U0` from its merge
// base with <base>.
//
// Exit 0, one line `verified by: script (...)`: no finding is `open`, and either
//   - the PR adds and removes the same lines at both commits (equal `git patch-id`): a merge of
//     the base that kept both sides; or
//   - every file whose part of the PR's diff changed is a test file (diff-kind.mjs's rule, docs
//     left out), and no changed line of it is a comment or a test title.
// Exit 1, one `fix-kind: <what>: <why>` line each: an open finding, <previous> no ancestor of
// <head> (a rebase), a changed file that is no test, a changed comment or test title. The fix
// gets its fix-check. Exit 2: usage, or a commit this clone lacks.
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

const isTest = (path) =>
  (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || path.startsWith("e2e/")) && !/\.mdx?$/.test(path);
const COMMENT = /(?:^|\s)\/\/|\/\*|^\*/;
const TITLE =
  /\b(?:it|test|describe)(?:\.\w+)*(?:\([^)]*\))?\s*\(\s*["'`]|^\]?\)\(\s*["'`]|^["'`].*["'`],?$/;

const reasons = findings
  .filter((f) => f.outcome === "open")
  .map((f) => `${f.id}: the finding is open, and its fix needs the check`);
if (spawnSync("git", ["merge-base", "--is-ancestor", previous, head]).status !== 0) {
  reasons.push(`${previous.slice(0, 9)}: not an ancestor of the head; a rebase needs the check`);
}
const before = prDiff(previous);
const after = prDiff(head);
// why: patch-id reads no bytes of a binary file, so with equal ids those are still compared.
const compared = before.id === after.id ? (line) => line.startsWith("binary ") : () => true;
const part = (diff, path) => (diff.files.get(path) ?? []).filter(compared).join("\n");
const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter(
  (path) => part(before, path) !== part(after, path),
);
for (const path of changed) {
  if (!isTest(path)) {
    reasons.push(`${path}: not a test file`);
    continue;
  }
  const claim = delta(before.files.get(path) ?? [], after.files.get(path) ?? [])
    .map((line) => line.slice(1).trim())
    .find((line) => COMMENT.test(line) || TITLE.test(line));
  if (claim !== undefined) {
    reasons.push(`${path}: a comment or test title changed: "${claim.slice(0, 60)}"`);
  }
}
if (reasons.length > 0) {
  for (const reason of reasons) console.log(`fix-kind: ${reason}`);
  process.exit(1);
}
const range = `${previous.slice(0, 9)}..${head.slice(0, 9)}`;
console.log(
  changed.length === 0
    ? `verified by: script (fix-kind ${range}: the PR adds and removes the same lines)`
    : `verified by: script (fix-kind ${range}: only test code changed: ${changed.join(", ")})`,
);

// why: -U0 leaves a merge's new context lines out, so only the PR's own lines are compared.
function prDiff(commit) {
  const fork = git("merge-base", commit, base).trim();
  const text = git("diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", fork, commit);
  const id = execFileSync("git", ["patch-id", "--stable"], { encoding: "utf8", input: text });
  const files = new Map();
  let lines = null;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(.*) b\/\1$/.exec(line);
    if (header !== null) {
      lines = [];
      files.set(header[1], lines);
    } else if (line.startsWith("Binary files ")) {
      const blob = spawnSync("git", ["rev-parse", `${commit}:${[...files.keys()].at(-1)}`], {
        encoding: "utf8",
      });
      lines?.push(`binary ${blob.stdout.trim()}`);
    } else if (/^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line)) {
      lines?.push(line);
    }
  }
  return { id: id.split(" ")[0] ?? "", files };
}

function delta(old, now) {
  const left = (from, other) => {
    const counts = new Map();
    for (const line of other) counts.set(line, (counts.get(line) ?? 0) + 1);
    return from.filter((line) => {
      const count = counts.get(line) ?? 0;
      counts.set(line, count - 1);
      return count <= 0;
    });
  };
  return [...left(old, now), ...left(now, old)];
}

function refuse(message) {
  console.error(message);
  process.exit(2);
}

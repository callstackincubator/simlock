#!/usr/bin/env node
// `node .agents/scripts/fix-kind.mjs <previous> <head> --base <sha> --findings <file.json>`: says
// whether the commits after the last reviewed one need a fix-check (the deliver skill, step 2).
// <previous> is the commit the last check reviewed, <base> the `base` line of pr-shas.sh,
// <file.json> the PR's findings file. The PR's diff at a commit is `git diff -U0` from its merge
// base with <base>.
//
// Exit 0, one line `verified by: script (...)`: no finding is `open`, and either
//   - the PR adds and removes the same lines at both commits, compared character for character:
//     a merge of the base that kept both sides; or
//   - every file whose part of the PR's diff changed is a test script (diff-kind.mjs's rule; a
//     `.ts` or `.js` file, no JSX), and between the two commits only numbers changed in it, or
//     blank lines, each provably outside every string and comment: the line pair is equal but
//     for digits outside its quotes, it holds no backtick, backslash or bare slash, no backtick
//     comes before it in the file, and no block comment is open above it.
// Exit 1, one `fix-kind: <what>: <why>` line each: an open finding, <previous> no ancestor of
// <head> (a rebase), a changed file that is no test script, a changed test line the script
// cannot prove holds no title, string or comment. The fix gets its fix-check. Exit 2: usage, or
// a commit this clone lacks.
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

const isTest = (path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || path.startsWith("e2e/");
const SCRIPT = /\.[cm]?[jt]s$/;

const reasons = findings
  .filter((f) => f.outcome === "open")
  .map((f) => `${f.id}: the finding is open, and its fix needs the check`);
if (spawnSync("git", ["merge-base", "--is-ancestor", previous, head]).status !== 0) {
  reasons.push(`${previous.slice(0, 9)}: not an ancestor of the head; a rebase needs the check`);
}
const before = prDiff(previous);
const after = prDiff(head);
const part = (diff, path) => (diff.get(path) ?? []).join("\n");
const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
  (path) => part(before, path) !== part(after, path),
);
for (const path of changed) {
  if (!isTest(path) || !SCRIPT.test(path)) {
    reasons.push(`${path}: not a test script`);
    continue;
  }
  const unsure = unsureLine(path);
  if (unsure !== null) {
    reasons.push(
      `${path}: more than a number outside strings and comments changed: "${unsure.trim().slice(0, 60)}"`,
    );
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
    : `verified by: script (fix-kind ${range}: only numbers in test code changed: ${changed.join(", ")})`,
);

// why: -U0 leaves a merge's new context lines out, so only the PR's own lines are compared.
function prDiff(commit) {
  const fork = git("merge-base", commit, base).trim();
  const text = git("diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", fork, commit);
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
    } else if (/^(?:[+-]|old mode|new mode|new file mode|deleted file mode)/.test(line)) {
      if (!/^(?:\+\+\+|---) /.test(line)) lines?.push(line);
    }
  }
  return files;
}

// why: the first changed line of a test script that may hold a title, a string or a comment, or
// null when every hunk between the two commits is blank lines or numbers in plain code.
function unsureLine(path) {
  const texts = [previous, head].map((commit) => {
    const shown = spawnSync("git", ["show", `${commit}:${path}`], { encoding: "utf8" });
    return shown.status === 0 ? shown.stdout.split("\n") : [];
  });
  const diff = git(
    "diff",
    "-U0",
    "--no-renames",
    "--no-color",
    "--no-ext-diff",
    previous,
    head,
    "--",
    path,
  );
  for (const hunk of diff.split(/^@@ /m).slice(1)) {
    const at = /^-(\d+)(?:,\d+)? \+(\d+)/.exec(hunk);
    const body = hunk.split("\n").slice(1);
    const sides = ["-", "+"].map((sign, side) =>
      body
        .filter((line) => line.startsWith(sign))
        .map((line, i) => ({
          text: line.slice(1),
          n: Number(at[side + 1]) + i,
          file: texts[side],
        })),
    );
    const all = sides.flat();
    const unsure =
      all.find((line) => !inPlainCode(line)) ??
      (all.every((line) => line.text.trim() === "") ? undefined : unpaired(sides));
    if (unsure !== undefined) return unsure.text === "" ? "a blank line" : unsure.text;
  }
  return null;
}

// why: a removed line and the added line in its place must be the same text but for digits
// outside quotes, with nothing outside the quotes that could start a comment or a regex.
function unpaired([removed, added]) {
  if (removed.length !== added.length) return added[0] ?? removed[0];
  return added.find((line, i) => {
    const now = masked(line.text);
    return now === null || now !== masked(removed[i].text);
  });
}

// why: null for a line this cannot read as code and plain quoted strings: a template, an escape,
// a quote left open, or a slash or a leading star outside the quotes. Else the line with each
// number outside its quotes replaced by 0.
function masked(text) {
  if (/[`\\]/.test(text)) return null;
  let quote = null;
  let out = "";
  let code = "";
  let piece = "";
  const flush = () => {
    out += piece.replace(/(?<![\w$])\d[\d_.]*/g, "0");
    code += piece;
    piece = "";
  };
  for (const char of text) {
    if (quote !== null) {
      out += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      flush();
      quote = char;
      out += char;
    } else {
      piece += char;
    }
  }
  flush();
  return quote !== null || /\/|^\s*\*/.test(code) ? null : out;
}

// why: a line is inside no template literal when no backtick comes before it, inside no block
// comment when the last opener above it is closed, and continues no string when the line above
// ends without a backslash.
function inPlainCode({ file, n }) {
  const above = file.slice(0, n - 1).join("\n");
  const opened = above.lastIndexOf("/*");
  return (
    !above.includes("`") &&
    (opened === -1 || above.lastIndexOf("*/") >= opened + 2) &&
    !above.trimEnd().endsWith("\\")
  );
}

function refuse(message) {
  console.error(message);
  process.exit(2);
}

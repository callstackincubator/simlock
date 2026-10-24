#!/usr/bin/env node
// `node .agents/scripts/diff-kind.mjs <base> <head>`: prints the kind of the diff from <base> to
// <head>, which sets the reviews it gets (delivery rule 14):
//
//   adr-only       every path is under docs/internal/adr/
//   docs-only      every path is a Markdown or MDX file (MDX: the website's docs pages)
//   comments-only  every line changed outside Markdown and MDX is a comment or blank
//   tests-only     every path is a test or a Markdown file, at least one a test
//   large          more than 1500 changed lines, pnpm-lock.yaml left out
//   full           anything else
import { execFileSync } from "node:child_process";

const LARGE = 1500;
const [base, head] = process.argv.slice(2);
if (base === undefined || head === undefined) {
  console.error("usage: diff-kind.mjs <base> <head>");
  process.exit(64);
}

const rows = execFileSync("git", ["diff", "--numstat", "--no-renames", base, head], {
  encoding: "utf8",
  maxBuffer: 1 << 28,
})
  .split("\n")
  .filter((row) => row !== "")
  .map((row) => {
    const [added, deleted, path] = row.split("\t");
    return { path, lines: (Number(added) || 0) + (Number(deleted) || 0) };
  });

const isAdr = (path) => path.startsWith("docs/internal/adr/");
const isDoc = (path) => /\.mdx?$/.test(path);
const isTest = (path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || path.startsWith("e2e/");

const paths = rows.map((row) => row.path);
const changedLines = (selected) =>
  selected.length === 0
    ? []
    : execFileSync("git", ["diff", "-U0", "--no-color", base, head, "--", ...selected], {
        encoding: "utf8",
        maxBuffer: 1 << 28,
      })
        .split("\n")
        .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line))
        .map((line) => line.slice(1).trim());
const isShell = (path) => /\.(?:sh|bash)$/.test(path);
const code = paths.filter((path) => !isDoc(path));
const commentOnly =
  code.length > 0 &&
  changedLines(code.filter((path) => !isShell(path))).every(
    (line) => line === "" || /^(?:\/\/|\/\*|\*|\{\/\*)/.test(line),
  ) &&
  changedLines(code.filter(isShell)).every((line) => line === "" || /^#(?!!)/.test(line));
const changed = rows
  .filter((row) => row.path !== "pnpm-lock.yaml")
  .reduce((sum, row) => sum + row.lines, 0);

let kind = "full";
if (paths.length > 0 && paths.every(isAdr)) kind = "adr-only";
else if (paths.length > 0 && paths.every(isDoc)) kind = "docs-only";
else if (commentOnly) kind = "comments-only";
else if (paths.some(isTest) && paths.every((path) => isTest(path) || isDoc(path)))
  kind = "tests-only";
else if (changed > LARGE) kind = "large";
console.log(kind);

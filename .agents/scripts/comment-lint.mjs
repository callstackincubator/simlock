#!/usr/bin/env node
// `node .agents/scripts/comment-lint.mjs [--all] [--limit <n>] [--base <ref>] [--head <ref>]
// [<files>...]`: the mechanical half of architecture rule 17. Every comment block the diff from
// <base> (default origin/main) to <head> (default the working tree) adds or edits must be one of:
//
//   why       its first words are `why:` (any case)
//   link      it contains a URL (an upstream bug or a reference)
//   doc       a `/** */` block right above an `export` in a file `simlock/client` or
//             `simlock/admin` re-exports from (src/client/index.ts, src/admin/index.ts and
//             the files their `export ... from` lines reach)
//   usage     the first block of a script: a file under scripts/ or .agents/scripts/, or one
//             whose first line is a shebang
//   directive @ts-, oxlint-, fallow-ignore and the other tool directives (never listed)
//
// Anything else is printed as `path:line: ...` and the exit code is 1. `--all` judges every
// block in the touched files, unchanged ones too (the weekly comment routine). <files> restricts
// the paths, for the commit hook. `--limit <n>` keeps whole files, most listed blocks first (ties
// by path), while the total stays at or under n (the first file always), and says on stderr how
// many blocks in how many files it left for later runs. Whether a `why:` is true is the claims
// review's question.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listComments, trailingText } from "./comments.mjs";

const ENTRY_POINTS = ["src/client/index.ts", "src/admin/index.ts"];
const SCRIPT_DIRS = ["scripts/", ".agents/scripts/"];
const WHY = /^why:/i;
const URL = /https?:\/\//;
const MARKER = /^\s*(?:\{\/\*+|\/\*+|\/\/\/?|\*+|#)\s?/;

const args = process.argv.slice(2);
let all = false;
let base = "origin/main";
let head;
let limit;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--all") all = true;
  else if (args[i] === "--base") base = args[++i];
  else if (args[i] === "--head") head = args[++i];
  else if (args[i] === "--limit") limit = Number(args[++i]);
  else if (args[i].startsWith("--")) usage();
  else files.push(args[i]);
}
if (base === undefined || (args.includes("--head") && head === undefined)) usage();
if (args.includes("--limit") && !(Number.isInteger(limit) && limit > 0)) usage();

const publicFiles = exportedFrom(ENTRY_POINTS);
const blocks = listComments({ base, head, all, files: files.length > 0 ? files : null });
const listed = blocks.filter((b) => !allowed(b)).filter((b) => all || b.state !== "unchanged");
const bad = limit === undefined ? listed : withinLimit(listed, limit);
for (const b of bad) {
  console.log(`${b.path}:${b.start}: a comment starts with "why:" or goes (architecture rule 17)`);
}
if (bad.length > 0) {
  console.error(
    `comment-lint: ${bad.length} comment${bad.length === 1 ? "" : "s"} to delete, or to start with "why:" when it says why`,
  );
  process.exit(1);
}

function usage() {
  console.error(
    "usage: comment-lint.mjs [--all] [--limit <n>] [--base <ref>] [--head <ref>] [<files>...]",
  );
  process.exit(64);
}

function withinLimit(list, n) {
  const counts = new Map();
  for (const b of list) counts.set(b.path, (counts.get(b.path) ?? 0) + 1);
  // why: listComments lists files in path order and sort is stable, so ties stay in path order.
  const order = [...counts].sort((x, y) => y[1] - x[1]);
  const kept = new Set();
  let total = 0;
  for (const [file, count] of order) {
    if (kept.size > 0 && total + count > n) break;
    kept.add(file);
    total += count;
  }
  const left = list.length - total;
  const rest = counts.size - kept.size;
  console.error(
    `comment-lint: ${left} more comment${left === 1 ? "" : "s"} in ${rest} file${rest === 1 ? "" : "s"} left for later runs`,
  );
  return list.filter((b) => kept.has(b.path));
}

function allowed(block) {
  const shell = /\.(?:sh|bash)$/.test(block.path);
  const texts = block.trailing
    ? [trailingText(block.lines[0].text, shell)]
    : block.lines.map((l) => l.text.replace(MARKER, ""));
  const first = texts.map((t) => t.replace(/\*+\/\s*$/, "").trim()).find((t) => t !== "") ?? "";
  if (WHY.test(first)) return true;
  if (texts.some((t) => URL.test(t))) return true;
  if (isUsageHeader(block)) return true;
  return isDocOnExport(block);
}

function isUsageHeader(block) {
  if (block.trailing || block.start > 3) return false;
  if (SCRIPT_DIRS.some((d) => block.path.startsWith(d))) return true;
  if (!existsSync(block.path)) return false;
  return readFileSync(block.path, "utf8").startsWith("#!");
}

function isDocOnExport(block) {
  if (block.trailing || !publicFiles.has(block.path)) return false;
  if (!block.lines[0].text.trim().startsWith("/**")) return false;
  return block.next !== null && /^\s*export\b/.test(block.next.text);
}

function exportedFrom(entries) {
  const seen = new Set();
  const walk = (file, depth) => {
    if (seen.has(file) || depth > 5 || !existsSync(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^export\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)) {
      if (!m[1].startsWith(".")) continue;
      const target = resolveModule(path.posix.join(path.posix.dirname(file), m[1]));
      if (target !== null) walk(target, depth + 1);
    }
  };
  for (const entry of entries) walk(entry, 0);
  return seen;
}

function resolveModule(spec) {
  const stem = spec.replace(/\.js$/, "");
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, spec]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

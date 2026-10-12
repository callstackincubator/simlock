#!/usr/bin/env node
// `node .agents/scripts/comments.mjs [--all] <base> [<head>]`: every comment block a diff adds or
// edits, each with the code line after it. `--all` lists every comment block in the files the
// diff touches, unchanged ones too, for the weekly comment routine. Without <head>, the diff runs
// from <base> to the working tree, untracked files included. Code files only (JavaScript,
// TypeScript, shell); tool directives are left out. Prints nothing when no comment is listed.
// `comment-lint.mjs` imports `listComments({ base, head, all, files })` for the same blocks as
// data: `{ path, start, end, state, trailing, lines: [{ n, text }], next: { n, text } | null }`,
// and `trailingText(line, shell)` for the comment part of a code line.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SHELL = /\.(?:sh|bash)$/;
const DIRECTIVE =
  /^(?:\/\/\/?|\/\*+|\{\/\*+|\*|#)\s*(?:@ts-|oxlint-|eslint-|fallow-ignore|Stryker (?:disable|restore)|prettier-ignore|biome-ignore|c8 |istanbul |shellcheck |<reference |#?(?:end)?region\b)/;
const QUOTES = new Set(['"', "'", "`"]);

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

export function listComments({ base, head, all = false, files = null }) {
  const range = head === undefined ? [base] : [base, head];
  const wanted = files === null ? null : new Set(files);
  const blocks = [];
  for (const path of touchedFiles(range, head, wanted)) {
    const lines = fileText(path, head).split("\n");
    const added = addedLines(path, lines.length, range, head);
    const kinds = SHELL.test(path) ? shellKinds(lines) : scriptKinds(lines);
    blocks.push(...blocksIn(path, lines, kinds, added, all));
  }
  return blocks;
}

export function trailingText(line, shell = false) {
  const marker = shell ? "#" : "//";
  const at = unquotedIndex(line, marker);
  return at === -1 ? "" : line.slice(at + marker.length);
}

function touchedFiles(range, head, wanted) {
  const paths = git("diff", "--name-only", "--diff-filter=d", ...range).split("\n");
  if (head === undefined)
    paths.push(...git("ls-files", "--others", "--exclude-standard").split("\n"));
  return [...new Set(paths)]
    .filter((f) => SCRIPT.test(f) || SHELL.test(f))
    .filter((f) => wanted === null || wanted.has(f))
    .sort();
}

function fileText(path, head) {
  if (head !== undefined) return git("show", `${head}:${path}`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function blocksIn(path, lines, kinds, added, all) {
  const blocks = [];
  const shown = new Set();
  for (let n = 1; n <= lines.length; n++) {
    if (!kinds[n - 1].comment || shown.has(n) || !(all || added.has(n))) continue;
    const trailing = kinds[n - 1].code;
    const [start, end] = trailing ? [n, n] : extent(kinds, n);
    for (let i = start; i <= end; i++) shown.add(i);
    const block = blockAt(path, lines, added, start, end, trailing);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

function blockAt(path, lines, added, start, end, trailing) {
  const block = lines.slice(start - 1, end);
  if (block.every((l) => DIRECTIVE.test(l.trim()) || l.trim() === "")) return null;
  const changed = block.filter((_, i) => added.has(start + i)).length;
  return {
    path,
    start,
    end,
    state: changed === block.length ? "added" : changed > 0 ? "edited" : "unchanged",
    trailing,
    lines: block.map((l, i) => ({ n: start + i, text: l })),
    next: trailing ? null : nextCode(lines, end),
  };
}

function extent(kinds, n) {
  let [start, end] = [n, n];
  while (start > 1 && kinds[start - 2].comment && !kinds[start - 2].code) start--;
  while (end < kinds.length && kinds[end].comment && !kinds[end].code) end++;
  return [start, end];
}

function nextCode(lines, end) {
  const at = lines.findIndex((l, i) => i >= end && l.trim() !== "");
  return at === -1 ? null : { n: at + 1, text: lines[at] };
}

function addedLines(path, count, range, head) {
  const tracked = git("ls-files", "--", path).trim() !== "" || head !== undefined;
  if (!tracked) return new Set(Array.from({ length: count }, (_, i) => i + 1));
  const added = new Set();
  for (const line of git("diff", "-U0", "--no-color", ...range, "--", path).split("\n")) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const start = Number(hunk[1]);
    const size = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let i = start; i < start + size; i++) added.add(i);
  }
  return added;
}

function shellKinds(lines) {
  return lines.map((line, i) => {
    const t = line.trim();
    const comment = t.startsWith("#") && !(i === 0 && t.startsWith("#!"));
    return { comment, code: !comment };
  });
}

function scriptKinds(lines) {
  let inBlock = false;
  return lines.map((line) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      return { comment: true, code: false };
    }
    if (t.startsWith("//")) return { comment: true, code: false };
    const open = t.startsWith("/*") ? 2 : t.startsWith("{/*") ? 3 : -1;
    if (open !== -1) {
      if (!t.includes("*/", open)) inBlock = true;
      return { comment: true, code: false };
    }
    return { comment: unquotedIndex(line, "//") !== -1, code: true };
  });
}

function unquotedIndex(line, marker) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (QUOTES.has(c)) {
      quote = c;
      continue;
    }
    // why: `\//` is the end of a regex literal, not a comment.
    if (line.startsWith(marker, i) && line[i - 1] !== "\\") return i;
  }
  return -1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const all = args[0] === "--all";
  const [base, head] = all ? args.slice(1) : args;
  if (base === undefined) {
    console.error("usage: comments.mjs [--all] <base> [<head>]");
    process.exit(64);
  }
  const out = [];
  for (const b of listComments({ base, head, all })) {
    out.push(`${b.path}:${b.start === b.end ? b.start : `${b.start}-${b.end}`} (${b.state})`);
    for (const l of b.lines) out.push(`  ${l.n} | ${l.text}`);
    if (b.next !== null) out.push(`  ${b.next.n} > ${b.next.text}`);
  }
  if (out.length > 0) console.log(out.join("\n"));
}

#!/usr/bin/env node
// `node .agents/scripts/test-lint.mjs [--base <ref>] [--head <ref>] [<files>...]`: the mechanical
// half of testing rules 5, 6 and 10 and of always-in-scope 8, on the lines <head> (default the
// working tree) adds since it left <base> (default origin/main). In a test file (`*.test.ts`,
// `*.test.tsx`), an added line fails when it
//
//   testing 5   bounds real time: `expect(...).toBeLessThan/GreaterThan` on `Date.now()`,
//               `performance.now()` or `process.hrtime`, or on an x assigned from one of them in
//               the same test; `*.timing.test.ts` and `e2e/slow-*` files are exempt
//   testing 5   skips, focuses or defers a test: `it|test|describe.only|skip|todo`, or a
//               `skipIf(`/`runIf(`; exempt when the line reads a `SIMLOCK_` variable, a
//               `skipIf`/`runIf` on `process.platform`, and one in an `e2e/slow-*` file (the
//               slow lane gates itself on the machine)
//   testing 10  asserts what a failure also satisfies: `toBeInstanceOf(Error)`,
//               `.not.toBe("pending")`, or `?.(` inside an `expect(...)` on its own line
//   testing 6   adds a value import of a sibling internal file (`./x.js`, not index, testing,
//               definition or test-*) in a directory with an index.ts, with no `why:` comment in
//               the 3 lines (or the comment block) above the first `describe(`
//
// and in `src/contract/*.ts` (not tests) an added `z.string()` with no `.max(`, `.length(`,
// `.regex(`, `.uuid(` or `.datetime(` on its chain, a `z.array(` with no `.max(` or `.length(`,
// or any `z.record(` fails (always-in-scope 8), unless a `why:` comment sits right above it or
// its whole top-level declaration moved verbatim (whitespace, comments and trailing commas aside)
// from another `src/contract/` file, one removal excusing one addition.
// Strings and comments are never read as code, so a fixture in a string is no finding.
// Each finding prints as `path:line: <what to do> (<rule>)` and the exit code is 1. <files>
// restricts the paths, for the commit hook.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { changedFiles } from "./comments.mjs";

const MESSAGES = {
  time: "a bound on real time goes in a *.timing.test.ts file or the slow lane; here drive a fake clock and assert the exact value (testing 5)",
  skip: "never skip, focus or defer a test to get to green; fix it or delete it, and gate a live-device test on a SIMLOCK_ variable (testing 5)",
  vacuous:
    "this assertion also passes on a failure; assert the exact value, or the named error and its code (testing 10)",
  internal:
    'a test of an internal file says which reason holds in a "why:" comment above its first describe (pure logic with many cases, an ordering the surface cannot force, or a part of a decomposed module), or tests through index.ts (testing 6)',
  bound:
    'bound this wire input with .max(), .length() or .regex(), or say why it needs none in a "why:" comment right above (always-in-scope 8)',
};

const TEST_FILE = /\.test\.tsx?$/;
const TIMING_FILE = /\.timing\.test\.tsx?$/;
const SLOW_LANE = /^e2e\/slow-/;
const CONTRACT_FILE = /^src\/contract\/[^/]+\.ts$/;
const HELPER_FILE = /(?:^|\/)(?:testing|test-[^/]*)\.ts$/;
const CLOCK = /\b(?:Date\.now|performance\.now|process\.hrtime)\b/;
const BOUND = /\.toBe(?:Less|Greater)Than/;
const WHY = /\bwhy:/i;
// why: the files a component is entered through (`.dependency-cruiser.mjs`), so not internal.
const ENTRY_FILES = new Set(["index", "testing", "definition"]);

function usage() {
  console.error("usage: test-lint.mjs [--base <ref>] [--head <ref>] [<files>...]");
  process.exit(64);
}

// why: one entry per rule judged line by line; `applies` says which test files it reads.
const LINE_RULES = [
  {
    rule: "time",
    applies: (file) => !TIMING_FILE.test(file) && !SLOW_LANE.test(file),
    breaks: (source, n) => boundsRealTime(source.codeLines, n),
  },
  { rule: "skip", applies: () => true, breaks: skips },
  { rule: "vacuous", applies: () => true, breaks: vacuous },
];

// why: the chain methods that bound each wire shape; a record is never bounded by its chain.
const BOUNDED_BY = {
  string: ["max", "length", "regex", "uuid", "datetime"],
  array: ["max", "length"],
  record: [],
};

function sourceOf({ path: file, lines, added }) {
  const text = lines.join("\n");
  const code = mask(text);
  return { file, lines, added, text, code, codeLines: code.split("\n"), starts: lineStarts(text) };
}

function testFindings(changed) {
  const source = sourceOf(changed);
  const rules = LINE_RULES.filter((entry) => entry.applies(source.file));
  const out = [...source.added]
    .sort((a, b) => a - b)
    .flatMap((n) =>
      rules
        .filter((entry) => entry.breaks(source, n))
        .map((entry) => ({ path: source.file, line: n, rule: entry.rule })),
    );
  const internal = internalImportLine(source);
  if (internal !== undefined) out.push({ path: source.file, line: internal, rule: "internal" });
  return out;
}

function boundsRealTime(codeLines, n) {
  const line = codeLines[n - 1];
  if (!BOUND.test(line)) return false;
  if (new RegExp(`\\bexpect\\s*\\([^;]*${CLOCK.source}`).test(line)) return true;
  const bound = /\bexpect\s*\(\s*(\w+)\s*[,)]/.exec(line);
  return bound !== null && assignedFromClock(codeLines, n, bound[1]);
}

function assignedFromClock(codeLines, n, name) {
  const assigned = new RegExp(`\\b${name}\\s*=[^=;]*${CLOCK.source}`);
  for (let i = n - 1; i >= 1; i--) {
    if (assigned.test(codeLines[i - 1])) return true;
    if (/^\s*(?:it|test)\b[\w.]*\s*\(/.test(codeLines[i - 1])) return false;
  }
  return false;
}

function skips(source, n) {
  const line = source.codeLines[n - 1] ?? "";
  if (/\bSIMLOCK_/.test(source.lines[n - 1] ?? "")) return false;
  if (/\b(?:it|test|describe)\.(?:only|skip|todo)\b/.test(line)) return true;
  if (!/\b(?:it|test|describe)\.(?:skipIf|runIf)\s*\(/.test(line)) return false;
  return !SLOW_LANE.test(source.file) && !/\bprocess\.platform\b/.test(line);
}

function vacuous(source, n) {
  const raw = source.lines[n - 1] ?? "";
  const line = source.codeLines[n - 1] ?? "";
  if (/\.toBeInstanceOf\(\s*Error\s*\)/.test(line)) return true;
  const pending = /\.not\.toBe\(\s*["']pending["']/.exec(raw);
  if (pending !== null && line[pending.index] === raw[pending.index]) return true;
  return optionalCallInExpect(source.code, source.starts[n - 1], line);
}

function optionalCallInExpect(code, offset, line) {
  // why: only the argument's text on the expect's own line; a callback spread over the lines
  // below is setup, and its `?.(` is no assertion.
  return [...line.matchAll(/\bexpect\s*\(/g)].some((m) => {
    const open = offset + m.index + m[0].length - 1;
    const end = Math.min(closing(code, open), offset + line.length);
    return code.slice(open, end).includes("?.(");
  });
}

function internalImportLine(source) {
  if (!exists(`${path.posix.dirname(source.file)}/index.ts`)) return undefined;
  const line = firstAddedInternalImport(source);
  if (line === undefined) return undefined;
  const first = firstTestBlock(source.codeLines);
  if (first === -1) return undefined;
  return hasWhyAbove(source.lines, source.codeLines, first) ? undefined : line;
}

function firstAddedInternalImport({ text, code, starts, added }) {
  const importRe =
    /^[ \t]*import\s+(type\s+)?(?:[^;]*?)\bfrom\s*["']\.\/([^"'/]+?)(?:\.[jt]sx?)?["']/gm;
  return [...text.matchAll(importRe)]
    .filter((m) => isInternalValueImport(m, code))
    .map((m) => lineOf(starts, m.index + m[0].length - 1))
    .find((line) => added.has(line));
}

function isInternalValueImport(m, code) {
  if (m[1] !== undefined || code[m.index + m[0].indexOf("import")] !== "i") return false;
  return !ENTRY_FILES.has(m[2]) && !m[2].startsWith("test-");
}

function firstTestBlock(codeLines) {
  const first = codeLines.findIndex((l) => /^\s*describe\b[\w.]*\s*\(/.test(l));
  if (first !== -1) return first;
  return codeLines.findIndex((l) => /^\s*(?:it|test)\b[\w.]*\s*\(/.test(l));
}

function contractFindings(changed, moved) {
  const source = sourceOf(changed);
  const excused = movedDeclarations(source, moved.get(source.file));
  return [...source.code.matchAll(/\bz\s*\.\s*(string|array|record)\s*\(/g)]
    .filter((m) => unboundedAddedShape(source, m))
    .filter((m) => !excused.some((d) => d.start <= m.index && m.index < d.end))
    .map((m) => ({
      path: source.file,
      line: lineOf(source.starts, m.index + m[0].length - 1),
      rule: "bound",
    }));
}

function unboundedAddedShape(source, m) {
  const open = m.index + m[0].length - 1;
  if (!source.added.has(lineOf(source.starts, open))) return false;
  const chain = chainMethods(source.code, closing(source.code, open));
  if (BOUNDED_BY[m[1]].some((name) => chain.includes(name))) return false;
  const statement = lineOf(source.starts, m.index);
  return !hasWhyAbove(source.lines, source.codeLines, statement - 1, 1);
}

// why: the head declarations of one file that the diff moved in from another contract file, each
// one the earliest with added lines among those of its text, as many as the move excuses.
function movedDeclarations(source, counts = new Map()) {
  const left = new Map(counts);
  return declarations(source.text).filter((d) => {
    const n = left.get(d.key) ?? 0;
    const touched = lineRange(source.starts, d).some((line) => source.added.has(line));
    if (n === 0 || !touched) return false;
    left.set(d.key, n - 1);
    return true;
  });
}

function lineRange(starts, { start, end }) {
  const first = lineOf(starts, start);
  return Array.from({ length: lineOf(starts, end - 1) - first + 1 }, (_, i) => first + i);
}

// why: a split moves whole schemas between contract files unchanged, so a moved one is not new
// wire input. The unit is a whole top-level declaration (whitespace, comments and trailing commas
// aside): one the diff removes from a contract file excuses at most one identical declaration it
// adds to another, so a bound dropped anywhere in a moved schema, or a new copy of a line bounded
// in place, is still judged. Maps each file to its excused declaration texts and their counts.
function movedContractDeclarations(base, head) {
  const from = gitText(["merge-base", base, head ?? "HEAD"]).trim();
  const removed = [];
  const added = new Map();
  for (const file of changedContractFiles(from, head)) {
    const before = keyCounts(revisionText(from, file));
    const after = keyCounts(head === undefined ? workingText(file) : revisionText(head, file));
    removed.push(...surplus(before, after).map((key) => ({ file, key })));
    added.set(file, surplus(after, before));
  }
  const moved = new Map();
  for (const [file, keys] of added) {
    for (const key of keys) {
      const at = removed.findIndex((r) => r.key === key && r.file !== file);
      if (at === -1) continue;
      removed.splice(at, 1);
      const counts = moved.get(file) ?? new Map();
      moved.set(file, counts.set(key, (counts.get(key) ?? 0) + 1));
    }
  }
  return moved;
}

// why: every contract file the diff touches, deleted ones too, since a split may empty a file.
function changedContractFiles(from, head) {
  const range = head === undefined ? [from] : [from, head];
  const names = gitText(["diff", "--name-only", ...range, "--", "src/contract/"]).split("\n");
  if (head === undefined) {
    names.push(
      ...gitText(["ls-files", "--others", "--exclude-standard", "src/contract/"]).split("\n"),
    );
  }
  return [...new Set(names)].filter((f) => CONTRACT_FILE.test(f)).sort();
}

// why: each key once for every copy <counts> holds beyond what <other> holds.
function surplus(counts, other) {
  return [...counts].flatMap(([key, n]) => Array(Math.max(0, n - (other.get(key) ?? 0))).fill(key));
}

function keyCounts(text) {
  const counts = new Map();
  for (const { key } of declarations(text)) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

// why: each top-level statement of <text> as {start, end, key}: it ends at a `;` outside every
// bracket, or at a `}` that closes its last bracket at the end of a line (an interface, a
// function). The key is its text without comments, whitespace outside strings, or trailing commas.
function declarations(text) {
  const { code, kinds } = maskWithKinds(text);
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (start === -1 && !/\s/.test(c)) start = i;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    const ends = depth === 0 && (c === ";" || (c === "}" && endsBlock(code, i + 1)));
    if (!ends || start === -1) continue;
    out.push({ start, end: i + 1, key: keyOf(text, kinds, start, i + 1) });
    start = -1;
  }
  return out;
}

function endsBlock(code, from) {
  const rest = /^[ \t]*\n\s*(\S?)/.exec(code.slice(from));
  if (rest === null) return code.slice(from).trim() === "";
  return rest[1] === "" || !".,;)]?:|&=".includes(rest[1]);
}

function keyOf(text, kinds, start, end) {
  const kept = [];
  for (let i = start; i < end; i++) {
    if (kinds[i] === "comment" || (kinds[i] === undefined && /\s/.test(text[i]))) continue;
    if (kinds[i] === undefined && ")]}".includes(text[i]) && kept.at(-1)?.code === ",") kept.pop();
    kept.push({ ch: text[i], code: kinds[i] === undefined ? text[i] : null });
  }
  return kept.map((k) => k.ch).join("");
}

function revisionText(rev, file) {
  try {
    return execFileSync("git", ["show", `${rev}:${file}`], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function workingText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function gitText(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function chainMethods(code, from) {
  const names = [];
  const step = /^\s*\.\s*(\w+)\s*\(/;
  let at = from;
  for (;;) {
    const m = step.exec(code.slice(at, at + 200));
    if (m === null) return names;
    names.push(m[1]);
    at = closing(code, at + m[0].length - 1);
  }
}

// why: the index just past the `)` matching the `(` at <open>, or the end of the text.
function closing(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i + 1;
  }
  return code.length;
}

// why: a `why:` counts in the <within> lines above line index <index>, or anywhere in the comment
// block that ends right above it, so a long reason still reaches its describe.
function hasWhyAbove(rawLines, codeLines, index, within = 3) {
  for (let i = index - 1; i >= Math.max(0, index - within); i--) {
    if (WHY.test(rawLines[i]) && codeLines[i] !== rawLines[i]) return true;
  }
  return whyInCommentBlock(rawLines, codeLines, index);
}

function whyInCommentBlock(rawLines, codeLines, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (codeLines[i].trim() !== "" || rawLines[i].trim() === "") return false;
    if (WHY.test(rawLines[i])) return true;
  }
  return false;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function exists(file) {
  if (head === undefined) return existsSync(file);
  try {
    execFileSync("git", ["cat-file", "-e", `${head}:${file}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// why: blanks every comment and the inside of every string and template literal (keeping the
// quotes, the `${}` code and every newline), so a pattern matched on the result is code: a lint
// fixture written as a string in a test is not a finding. Each scanner reads one kind of token at
// `s.i` and moves past it; what none of them claims is code.
function mask(text) {
  return maskWithKinds(text).code;
}

// why: the masked code, and for each blanked index whether a comment or a string held it.
function maskWithKinds(text) {
  const s = { text, out: text.split(""), kinds: [], i: 0, braces: [], last: "" };
  while (s.i < text.length) (SCANNERS.find((scanner) => scanner.at(s)) ?? CODE).scan(s);
  return { code: s.out.join(""), kinds: s.kinds };
}

const SCANNERS = [
  { at: (s) => s.text.startsWith("//", s.i), scan: (s) => skipComment(s, "\n", 0) },
  { at: (s) => s.text.startsWith("/*", s.i), scan: (s) => skipComment(s, "*/", 2) },
  { at: (s) => s.text[s.i] === '"' || s.text[s.i] === "'", scan: scanQuoted },
  { at: (s) => s.text[s.i] === "`", scan: (s) => scanTemplate(s, s.i + 1) },
  { at: (s) => s.text[s.i] === "}" && s.braces.at(-1) === 0, scan: resumeTemplate },
  { at: (s) => s.text[s.i] === "/" && regexCanStart(s), scan: scanRegex },
];
const CODE = { scan: scanCode };

function blank(s, from, to, kind = "string") {
  for (let k = from; k < to; k++) {
    s.kinds[k] = kind;
    if (s.out[k] !== "\n") s.out[k] = " ";
  }
}

function skipComment(s, terminator, length) {
  const found = s.text.indexOf(terminator, s.i + 2);
  const stop = found === -1 ? s.text.length : found + length;
  blank(s, s.i, stop, "comment");
  s.i = stop;
}

function scanQuoted(s) {
  const quote = s.text[s.i];
  let j = s.i + 1;
  while (j < s.text.length && s.text[j] !== quote && s.text[j] !== "\n") {
    j += s.text[j] === "\\" ? 2 : 1;
  }
  blank(s, s.i + 1, Math.min(j, s.text.length));
  s.i = j + 1;
  s.last = quote;
}

function resumeTemplate(s) {
  s.braces.pop();
  scanTemplate(s, s.i + 1);
}

function scanTemplate(s, start) {
  let j = start;
  while (j < s.text.length && s.text[j] !== "`" && !s.text.startsWith("${", j)) {
    j += s.text[j] === "\\" ? 2 : 1;
  }
  blank(s, start, Math.min(j, s.text.length));
  if (s.text.startsWith("${", j)) s.braces.push(0);
  s.i = Math.min(j + (s.text[j] === "`" ? 1 : 2), s.text.length);
  s.last = "`";
}

function scanRegex(s) {
  let j = s.i + 1;
  let inClass = false;
  while (j < s.text.length && s.text[j] !== "\n") {
    const c = s.text[j];
    if (c === "/" && !inClass) break;
    if (c === "[" || c === "]") inClass = c === "[";
    j += c === "\\" ? 2 : 1;
  }
  s.i = j + 1;
  s.last = "/";
}

function scanCode(s) {
  const c = s.text[s.i];
  const top = s.braces.length - 1;
  if (top >= 0 && (c === "{" || c === "}")) s.braces[top] += c === "{" ? 1 : -1;
  if (!/\s/.test(c)) s.last = c;
  s.i++;
}

function regexCanStart(s) {
  if (s.last === "" || "(,=:[!&|?{};+-*%<>~^".includes(s.last)) return true;
  return /\b(?:return|typeof|case|of|in|yield|await|void|delete|throw)$/.test(
    s.text.slice(Math.max(0, s.i - 12), s.i).trimEnd(),
  );
}

// why: the run comes last, so every rule table above is initialised before it is read.
const args = process.argv.slice(2);
let base = "origin/main";
let head;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base") base = args[++i];
  else if (args[i] === "--head") head = args[++i];
  else if (args[i].startsWith("--")) usage();
  else files.push(args[i]);
}
if (base === undefined || (args.includes("--head") && head === undefined)) usage();

const findings = [];
const moved = movedContractDeclarations(base, head);
for (const file of changedFiles({ base, head, files: files.length > 0 ? files : null })) {
  if (TEST_FILE.test(file.path)) findings.push(...testFindings(file));
  else if (CONTRACT_FILE.test(file.path) && !HELPER_FILE.test(file.path)) {
    findings.push(...contractFindings(file, moved));
  }
}
const seen = new Set();
const unique = findings
  .map((f) => `${f.path}:${f.line}: ${MESSAGES[f.rule]}`)
  .filter((line) => !seen.has(line) && seen.add(line));
for (const line of unique) console.log(line);
if (unique.length > 0) {
  console.error(`test-lint: ${unique.length} finding${unique.length === 1 ? "" : "s"}`);
  process.exit(1);
}

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
// or any `z.record(` fails (always-in-scope 8), unless a `why:` comment sits right above it.
// Strings and comments are never read as code, so a fixture in a string is no finding.
// Each finding prints as `path:line: <what to do> (<rule>)` and the exit code is 1. <files>
// restricts the paths, for the commit hook.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { changedFiles } from "./comments.mjs";

const MESSAGES = {
  time: "a bound on real time goes in a *.timing.test.ts file or the slow lane; here drive a fake clock and assert the exact value (testing 5)",
  skip: "never skip, focus or defer a test to get to green; fix it or delete it, and gate a live-device test on a SIMLOCK_ variable (testing 5)",
  vacuous:
    "this assertion also passes on a failure; assert the exact value, or the named error and its code (testing 10)",
  internal:
    'a test of an internal file says which reason holds in a "why:" comment above its first describe (pure logic with many cases, or an ordering the surface cannot force), or tests through index.ts (testing 6)',
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

function contractFindings(changed) {
  const source = sourceOf(changed);
  return [...source.code.matchAll(/\bz\s*\.\s*(string|array|record)\s*\(/g)]
    .filter((m) => unboundedAddedShape(source, m))
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
  const s = { text, out: text.split(""), i: 0, braces: [], last: "" };
  while (s.i < text.length) (SCANNERS.find((scanner) => scanner.at(s)) ?? CODE).scan(s);
  return s.out.join("");
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

function blank(s, from, to) {
  for (let k = from; k < to; k++) if (s.out[k] !== "\n") s.out[k] = " ";
}

function skipComment(s, terminator, length) {
  const found = s.text.indexOf(terminator, s.i + 2);
  const stop = found === -1 ? s.text.length : found + length;
  blank(s, s.i, stop);
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
for (const file of changedFiles({ base, head, files: files.length > 0 ? files : null })) {
  if (TEST_FILE.test(file.path)) findings.push(...testFindings(file));
  else if (CONTRACT_FILE.test(file.path) && !HELPER_FILE.test(file.path)) {
    findings.push(...contractFindings(file));
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

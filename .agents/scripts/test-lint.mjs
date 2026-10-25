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

function usage() {
  console.error("usage: test-lint.mjs [--base <ref>] [--head <ref>] [<files>...]");
  process.exit(64);
}

function testFindings({ path: file, lines, added }) {
  const text = lines.join("\n");
  const code = mask(text);
  const codeLines = code.split("\n");
  const starts = lineStarts(text);
  const out = [];
  const at = (rule, line) => out.push({ path: file, line, rule });
  for (const n of [...added].sort((a, b) => a - b)) {
    const raw = lines[n - 1] ?? "";
    const line = codeLines[n - 1] ?? "";
    if (!TIMING_FILE.test(file) && !SLOW_LANE.test(file) && boundsRealTime(codeLines, n)) {
      at("time", n);
    }
    if (skips(file, raw, line)) at("skip", n);
    if (vacuous(code, starts[n - 1], raw, line)) at("vacuous", n);
  }
  const internal = internalImportLine(file, text, code, added);
  if (internal !== undefined) at("internal", internal);
  return out;
}

function boundsRealTime(codeLines, n) {
  const line = codeLines[n - 1];
  if (!BOUND.test(line)) return false;
  if (new RegExp(`\\bexpect\\s*\\([^;]*${CLOCK.source}`).test(line)) return true;
  const bound = /\bexpect\s*\(\s*(\w+)\s*[,)]/.exec(line);
  if (bound === null) return false;
  const assigned = new RegExp(`\\b${bound[1]}\\s*=[^=;]*${CLOCK.source}`);
  for (let i = n - 1; i >= 1; i--) {
    if (assigned.test(codeLines[i - 1])) return true;
    if (/^\s*(?:it|test)\b[\w.]*\s*\(/.test(codeLines[i - 1])) return false;
  }
  return false;
}

function skips(file, raw, line) {
  if (/\bSIMLOCK_/.test(raw)) return false;
  if (/\b(?:it|test|describe)\.(?:only|skip|todo)\b/.test(line)) return true;
  if (!/\b(?:it|test|describe)\.(?:skipIf|runIf)\s*\(/.test(line)) return false;
  return !SLOW_LANE.test(file) && !/\bprocess\.platform\b/.test(line);
}

function vacuous(code, offset, raw, line) {
  if (/\.toBeInstanceOf\(\s*Error\s*\)/.test(line)) return true;
  const pending = /\.not\.toBe\(\s*["']pending["']/.exec(raw);
  if (pending !== null && line[pending.index] === raw[pending.index]) return true;
  for (const m of line.matchAll(/\bexpect\s*\(/g)) {
    // why: only the argument's text on the expect's own line; a callback spread over the lines
    // below is setup, and its `?.(` is no assertion.
    const open = offset + m.index + m[0].length - 1;
    const end = Math.min(closing(code, open), offset + line.length);
    if (code.slice(open, end).includes("?.(")) return true;
  }
  return false;
}

function internalImportLine(file, text, code, added) {
  const dir = path.posix.dirname(file);
  if (!exists(`${dir}/index.ts`)) return undefined;
  const starts = lineStarts(text);
  const importRe =
    /^[ \t]*import\s+(type\s+)?(?:[^;]*?)\bfrom\s*["']\.\/([^"'/]+?)(?:\.[jt]sx?)?["']/gm;
  let line;
  for (const m of text.matchAll(importRe)) {
    if (m[1] !== undefined || code[m.index + m[0].indexOf("import")] !== "i") continue;
    if (ENTRY_FILES.has(m[2]) || m[2].startsWith("test-")) continue;
    const at = lineOf(starts, m.index + m[0].length - 1);
    if (added.has(at)) {
      line = at;
      break;
    }
  }
  if (line === undefined) return undefined;
  const codeLines = code.split("\n");
  const rawLines = text.split("\n");
  let first = codeLines.findIndex((l) => /^\s*describe\b[\w.]*\s*\(/.test(l));
  if (first === -1) first = codeLines.findIndex((l) => /^\s*(?:it|test)\b[\w.]*\s*\(/.test(l));
  if (first === -1) return undefined;
  return hasWhyAbove(rawLines, codeLines, first) ? undefined : line;
}

function contractFindings({ path: file, lines, added }) {
  const text = lines.join("\n");
  const code = mask(text);
  const starts = lineStarts(text);
  const rawLines = text.split("\n");
  const codeLines = code.split("\n");
  const out = [];
  for (const m of code.matchAll(/\bz\s*\.\s*(string|array|record)\s*\(/g)) {
    const line = lineOf(starts, m.index + m[0].length - 1);
    if (!added.has(line)) continue;
    const close = closing(code, m.index + m[0].length - 1);
    const chain = chainMethods(code, close);
    const bounded =
      m[1] === "string"
        ? ["max", "length", "regex", "uuid", "datetime"].some((name) => chain.includes(name))
        : m[1] === "array"
          ? chain.includes("max") || chain.includes("length")
          : false;
    if (bounded) continue;
    const statement = lineOf(starts, m.index);
    if (hasWhyAbove(rawLines, codeLines, statement - 1, 1)) continue;
    out.push({ path: file, line, rule: "bound" });
  }
  return out;
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
  let i = index - 1;
  while (i >= 0 && codeLines[i].trim() === "" && rawLines[i].trim() !== "") {
    if (WHY.test(rawLines[i])) return true;
    i--;
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
// fixture written as a string in a test is not a finding.
function mask(text) {
  const out = text.split("");
  const n = text.length;
  const braces = [];
  let last = "";
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const template = (j) => {
    const start = j;
    while (j < n) {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "`") {
        blank(start, j);
        return j + 1;
      } else if (text[j] === "$" && text[j + 1] === "{") {
        blank(start, j);
        braces.push(0);
        return j + 2;
      } else j++;
    }
    blank(start, n);
    return n;
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      last = c;
    } else if (c === "`") {
      i = template(i + 1);
      last = "`";
    } else if (c === "}" && braces.length > 0 && braces[braces.length - 1] === 0) {
      braces.pop();
      i = template(i + 1);
      last = "`";
    } else if (c === "/" && regexCanStart(text, i, last)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      last = "/";
    } else {
      if (braces.length > 0 && c === "{") braces[braces.length - 1]++;
      if (braces.length > 0 && c === "}") braces[braces.length - 1]--;
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out.join("");
}

function regexCanStart(text, i, last) {
  if (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last)) return true;
  return /\b(?:return|typeof|case|of|in|yield|await|void|delete|throw)$/.test(
    text.slice(Math.max(0, i - 12), i).trimEnd(),
  );
}

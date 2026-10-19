#!/usr/bin/env node
// `pnpm mutate [base] [--max-lines <n>]`: mutation-test only the source lines this branch changed
// against base (default origin/main), with the unit suite, and print each mutant the suite let live.
// A near pass runs only the unit test files that import a mutated file directly and those the
// branch changed; a wide pass gives each mutant the near pass left alive every unit test file
// Vitest finds related to its file, through any depth of imports.
// With --max-lines, it takes the changed files newest first (by the last commit on HEAD's
// first-parent history that touched each; uncommitted changes are newest of all) until the next
// file would pass n changed lines, cuts a first file larger than n at n, and prints what it skipped.
// Results are kept per branch in the clone's git directory, shared by its worktrees: a run reuses
// every mutant whose code and covering tests did not change, and a run with nothing changed
// under src/ or ui/src/ and the same lines to mutate since the branch's last run reprints that
// run's result.
//
// A survivor is a line you can change, or delete, with a green suite: testing rules 2 and 3.
// Exit 0 when every mutant died, 1 when any survived or had no covering test, 2 when Stryker
// failed without a report.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const REPORT = ".stryker-tmp/report/mutation.json";
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const SOURCES = ["src/*.ts", "ui/src/*.ts", "ui/src/*.tsx", ":!*.test.ts", ":!*.test.tsx"];
const args = process.argv.slice(2);
const flag = args.indexOf("--max-lines");
const maxLines = flag === -1 ? null : Number(args[flag + 1]);
if (flag !== -1) args.splice(flag, 2);
if (maxLines !== null && !(Number.isInteger(maxLines) && maxLines > 0)) {
  console.error("--max-lines takes a whole number of lines above 0.");
  process.exit(2);
}
const base = args[0] ?? "origin/main";
const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" });

const mergeBase = git("merge-base", base, "HEAD").trim();
const diff = git("diff", "-U0", "--no-color", mergeBase, "--", ...SOURCES);

const changed = new Map();
let file = null;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) file = line === "+++ /dev/null" ? null : line.slice(6);
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (file !== null && hunk !== null) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) changed.set(file, [...(changed.get(file) ?? []), { start, count }]);
  }
}

if (changed.size === 0) {
  console.log(`No changed source lines under src/ or ui/src/ since ${base}; nothing to mutate.`);
  process.exit(0);
}

const ranges = [];
const skipped = [];
let taken = 0;
let skippedLines = 0;
for (const [path, hunks] of maxLines === null ? changed : newestFirst()) {
  const lines = hunks.reduce((sum, h) => sum + h.count, 0);
  if (maxLines === null || (skipped.length === 0 && taken + lines <= maxLines)) {
    for (const h of hunks) ranges.push(`${path}:${h.start}-${h.start + h.count - 1}`);
    taken += lines;
  } else if (taken === 0) {
    for (const h of hunks) {
      const count = Math.min(h.count, maxLines - taken);
      if (count > 0) ranges.push(`${path}:${h.start}-${h.start + count - 1}`);
      taken += count;
    }
    skipped.push(`${path} (past its first ${maxLines} changed lines)`);
    skippedLines += lines - maxLines;
  } else {
    skipped.push(path);
    skippedLines += lines;
  }
}
if (skipped.length > 0) {
  console.log(
    `Skipped ${skipped.length} files and ${skippedLines} changed lines past --max-lines ${maxLines}:`,
  );
  for (const path of skipped) console.log(`  ${path}`);
}
const mutate = ranges.join(",");

const cache = join(git("rev-parse", "--path-format=absolute", "--git-common-dir").trim(), "mutate");
mkdirSync(cache, { recursive: true });
for (const name of readdirSync(cache)) {
  if (Date.now() - statSync(join(cache, name)).mtimeMs > KEEP_MS) rmSync(join(cache, name));
}
// Keyed by the branch's first commit, not its name: fix runs push the branch from local
// branches of other names.
const branch = join(
  cache,
  git("rev-list", "--reverse", "--first-parent", `${mergeBase}..HEAD`).split("\n")[0],
);
const sources = git("ls-tree", "HEAD", "--", "src", "ui/src");
const clean = git("status", "--porcelain", "--", "src", "ui/src").trim() === "";
const last = existsSync(`${branch}.last.json`)
  ? JSON.parse(readFileSync(`${branch}.last.json`, "utf8"))
  : null;

if (clean && last?.sources === sources && last.mutate === mutate) {
  console.log(
    `Nothing under src/ or ui/src/ changed since this branch's last run; its result stands.`,
  );
  print(last.total, ranges.length, last.alive);
}

// why: Stryker's first run executes every test it may use, to learn which test covers which
// line, and Vitest's related mode follows imports through any depth: one changed file can
// pull in thousands of tests. So the near pass runs only the test files that import a mutated
// file directly, plus the test files the branch changed; the wide pass gives the mutants that
// near pass left alive the whole related set. A mutant is reported alive only when the related
// set lets it live, as a single related run would.
const near = nearTests([...new Set(ranges.map((r) => r.slice(0, r.indexOf(":"))))]);
let total = 0;
let alive = [];
let wideMutate = mutate;
let nearAlive = null;
if (near.length > 0) {
  console.log(`Near pass: ${near.length} test files that import a mutated file directly.`);
  const report = stryker(mutate, near, `${branch}.json`);
  total = report.total;
  wideMutate = report.alive.map((m) => m.range).join(",");
  nearAlive = new Set(report.alive.map((m) => m.key));
}
if (wideMutate !== "") {
  console.log(`Wide pass: ${wideMutate.split(",").length} ranges with every related test file.`);
  const report = stryker(
    wideMutate,
    [],
    near.length > 0 ? `${branch}.wide.json` : `${branch}.json`,
  );
  if (near.length === 0) total = report.total;
  // why: a range can hold a mutant the near pass killed, and a branch's changed test file need
  // not be related to the file, so only a mutant both passes left alive is alive.
  alive = report.alive.filter((m) => nearAlive?.has(m.key) ?? true).map((m) => m.text);
}
if (clean) {
  writeFileSync(`${branch}.last.json`, JSON.stringify({ sources, mutate, total, alive }));
}
print(total, ranges.length, alive);

function stryker(mutate, testFiles, incrementalFile) {
  // why: a killed run leaves its sandboxes behind, and a stale report would be read as this one.
  rmSync(".stryker-tmp", { force: true, recursive: true });
  const only = testFiles.length > 0 ? ["--testFiles", testFiles.join(",")] : [];
  const argv = ["exec", "stryker", "run", "--mutate", mutate, ...only];
  argv.push("--incremental", "--incrementalFile", incrementalFile);
  const run = spawnSync("pnpm", argv, {
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stderr = run.stderr ?? "";
  process.stderr.write(stderr);
  if (!existsSync(REPORT)) failed(run.status, stderr);
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  const mutants = Object.entries(report.files).flatMap(([path, file]) =>
    file.mutants.map((m) => ({ path, ...m })),
  );
  const alive = mutants
    .filter((m) => m.status === "Survived" || m.status === "NoCoverage")
    .map(described);
  return { total: mutants.length, alive };
}

function failed(status, stderr) {
  // why: last, so a caller that keeps only the tail of the output still sees the cause.
  const tail = stderr.trimEnd().split("\n").slice(-15).join("\n");
  console.error(`\nStryker exited ${status} without a report: no mutant was tested.\n${tail}`);
  process.exit(2);
}

function described({ path, location: { start, end }, mutatorName, replacement, status }) {
  const shown = (replacement ?? "").replace(/\s+/g, " ").slice(0, 80);
  return {
    // why: the report counts columns from 1 and a --mutate range from 0; keeping the end
    // as reported widens the range by one column, which can only take this mutant in.
    range: `${path}:${start.line}:${start.column - 1}-${end.line}:${end.column}`,
    key: `${path}:${start.line}:${start.column}-${end.line}:${end.column} ${mutatorName} ${replacement}`,
    text: `${path}:${start.line} ${status} ${mutatorName}: ${shown}`,
  };
}

// why: a module's own tests reach it through its index.ts (architecture rule 14), so a test
// that imports a barrel re-exporting a mutated file counts when it sits in that barrel's
// directory; tests elsewhere import the barrel as callers and are left to the wide pass. A
// mutated file that only re-exports has no mutant, so its importers are not taken for it. The
// test files are vitest.mutate.config.ts's unit set.
function nearTests(files) {
  const reExport = /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["'](\.[^"']+)["'];?/gm;
  const importLine = /^\s*import\s[^;]*?from\s+["'][^"']+["'];?/gm;
  const comment = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
  const specifier = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;
  const resolve = (from, s) => {
    const path = join(dirname(from), s);
    return [path, path.replace(/\.jsx?$/, ".ts"), path.replace(/\.jsx?$/, ".tsx")].find(
      (p) => statSync(p, { throwIfNoEntry: false })?.isFile() === true,
    );
  };
  const source = (f) => readFileSync(f, "utf8").replace(comment, "");
  const targets = new Set(
    files.filter((f) => source(f).replace(reExport, "").replace(importLine, "").trim() !== ""),
  );
  // why: a barrel may re-export another barrel, so a chain is followed to its files.
  const exposed = new Map();
  const exposes = (file) => {
    if (exposed.has(file)) return exposed.get(file);
    const found = new Set();
    exposed.set(file, found);
    const targets = [...source(file).matchAll(reExport)].map(([, s]) => resolve(file, s));
    for (const target of targets.filter((t) => t !== undefined)) {
      found.add(target);
      exposes(target).forEach((t) => found.add(t));
    }
    return found;
  };
  const reaches = (test, imported) =>
    targets.has(imported) ||
    (test.startsWith(`${dirname(imported)}/`) &&
      [...exposes(imported)].some((f) => targets.has(f)));
  const unit = (f) => f !== "" && !f.endsWith(".timing.test.ts");
  const globs = ["src/*.test.ts", "ui/*.test.ts", "ui/*.test.tsx"];
  const tests = git("ls-files", ...globs)
    .split("\n")
    .filter(unit);
  const changedTests = git("diff", "--name-only", "--diff-filter=d", mergeBase, "--", ...globs)
    .split("\n")
    .filter(unit);
  const picked = tests.filter((test) =>
    [...readFileSync(test, "utf8").matchAll(specifier)].some(([, s]) => {
      const imported = resolve(test, s);
      return imported !== undefined && reaches(test, imported);
    }),
  );
  return [...new Set([...picked, ...changedTests])];
}

function print(total, rangeCount, alive) {
  console.log(`\n${total} mutants on ${rangeCount} changed ranges; ${alive.length} alive.`);
  for (const line of alive) console.log(line);
  if (alive.length > 0) console.log("Kill each one, or explain it in the PR body.");
  process.exit(alive.length === 0 ? 0 : 1);
}

function newestFirst() {
  const order = [
    ...git("diff", "--name-only", "HEAD", "--", ...SOURCES).split("\n"),
    ...git(
      "log",
      "--first-parent",
      "--diff-merges=first-parent",
      "--format=",
      "--name-only",
      `${mergeBase}..HEAD`,
      "--",
      ...SOURCES,
    ).split("\n"),
  ];
  const rank = (path) => (order.includes(path) ? order.indexOf(path) : order.length);
  return [...changed].sort(([a], [b]) => rank(a) - rank(b));
}

#!/usr/bin/env node
// `pnpm mutate [base]`: mutation-test only the source lines this branch changed against base
// (default origin/main), with the unit suite, and print each mutant the suite let live.
//
// A survivor is a line you can change, or delete, with a green suite: testing rules 2 and 3.
// Exit 0 when every mutant died, 1 when any survived or had no covering test.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const REPORT = ".stryker-tmp/report/mutation.json";
const base = process.argv[2] ?? "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const mergeBase = git("merge-base", base, "HEAD").trim();
const diff = git("diff", "-U0", "--no-color", mergeBase, "--", "src/*.ts", ":!*.test.ts");

/** `file:start-end` for every hunk that adds lines, the form Stryker's --mutate takes. */
const ranges = [];
let file = null;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) file = line === "+++ /dev/null" ? null : line.slice(6);
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (file !== null && hunk !== null) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.push(`${file}:${start}-${start + count - 1}`);
  }
}

if (ranges.length === 0) {
  console.log(`No changed source lines under src/ since ${base}; nothing to mutate.`);
  process.exit(0);
}

// A killed run leaves its sandboxes behind; start clean.
rmSync(".stryker-tmp", { force: true, recursive: true });
const run = spawnSync("pnpm", ["exec", "stryker", "run", "--mutate", ranges.join(",")], {
  stdio: ["ignore", "inherit", "inherit"],
});
if (!existsSync(REPORT)) {
  console.error(`Stryker exited ${run.status} without a report.`);
  process.exit(run.status || 1);
}

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const alive = [];
let total = 0;
for (const [path, { mutants }] of Object.entries(report.files)) {
  for (const m of mutants) {
    total += 1;
    if (m.status === "Survived" || m.status === "NoCoverage") {
      const replacement = (m.replacement ?? "").replace(/\s+/g, " ").slice(0, 80);
      alive.push(`${path}:${m.location.start.line} ${m.status} ${m.mutatorName}: ${replacement}`);
    }
  }
}

console.log(`\n${total} mutants on ${ranges.length} changed ranges; ${alive.length} alive.`);
for (const line of alive) console.log(line);
process.exit(alive.length === 0 ? 0 : 1);

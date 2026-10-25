#!/usr/bin/env node
// `node .agents/scripts/delivery-counters.mjs --since YYYY-MM-DD`: the counters that judge the
// delivery changes in PROCESS-REVIEW-2026-10-21.md (items 4 to 12), one row per PR merged since
// the date, from the PR's tagged runs on this machine and its files on GitHub:
//
//   ci lines      `ci:` lines the orchestrator put into fix prompts (CI failures sent to a fix run)
//   syncs         fix runs asked to merge the base or sync the stack
//   empty builds  build runs that built no cycle, or ended with no report at all
//   no-change     fix runs whose report fixed nothing (`found 0 fixed 0` on every line)
//   Tests lines   lines under the issue's `### Tests`
//   tests added   `it(`/`test(` blocks the PR adds in *.test.ts and *.spec.ts
//   test/src LOC  lines added to test files over lines added to other .ts files
//
// Unknown values print as `-`. Replays (stage=replay) never count. The repo is GH_REPO, else
// the origin remote's owner/name.
import { execFileSync } from "node:child_process";
import { runOf, taggedRuns } from "./transcripts.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--since");
const since = at === -1 ? null : args[at + 1];
if (since === null || Number.isNaN(Date.parse(since))) {
  console.error("usage: delivery-counters.mjs --since YYYY-MM-DD");
  process.exit(64);
}

const repo =
  process.env.GH_REPO ??
  execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })
    .trim()
    .replace(/\.git$/, "")
    .replace(/.*[/:]([^/:]+\/[^/]+)$/, "$1");
const api = (path, ...extra) =>
  JSON.parse(
    execFileSync("gh", ["api", "-X", "GET", `repos/${repo}/${path}`, ...extra], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

const merged = [];
for (let page = 1; page <= 5; page += 1) {
  const pulls = api(
    "pulls",
    "-f",
    "state=closed",
    "-f",
    "sort=updated",
    "-f",
    "direction=desc",
    "-f",
    "per_page=100",
    "-f",
    `page=${page}`,
  );
  for (const p of pulls) if (p.merged_at && p.merged_at >= since) merged.push(p);
  if (pulls.length < 100 || pulls.every((p) => (p.updated_at ?? "") < since)) break;
}
merged.sort((a, b) => a.number - b.number);

const runs = taggedRuns().filter(({ tag }) => tag.stage !== "replay");
const rows = [];
for (const p of merged) {
  const issue = /^(?:bug|feature|task)\/(\d+)$/.exec(p.head.ref)?.[1] ?? null;
  const mine = runs
    .filter(({ tag }) => tag.pr === String(p.number) || (issue !== null && tag.issue === issue))
    .map(({ file, tag }) => ({ tag, ...runOf(file) }));
  const fixes = mine.filter((r) => r.tag.stage === "fix");
  const ci = fixes.reduce((n, r) => n + (r.prompt.match(/^\s*-?\s*ci:/gm) ?? []).length, 0);
  const syncs = fixes.filter((r) =>
    /gh stack sync|merge (?:the |its )?base|stack: /i.test(r.prompt),
  ).length;
  // why: a build that could not start (a base behind main, a missing brief) ends with no report
  // at all, which is the other way a build run builds nothing.
  const empty = mine.filter(
    (r) =>
      r.tag.stage === "build" && (r.lastText.trim() === "" || /^cycles:\s*0\//m.test(r.lastText)),
  ).length;
  const noChange = fixes.filter((r) => {
    const found = [...r.lastText.matchAll(/-> found (\d+) fixed (\d+)/g)];
    return found.length > 0 && found.every((m) => m[2] === "0");
  }).length;

  let testsLines = null;
  if (issue !== null) {
    const body = api(`issues/${issue}`).body ?? "";
    const section = /^### Tests\s*$([\s\S]*?)(?=^#|$(?![\s\S]))/m.exec(body)?.[1] ?? "";
    testsLines = (section.match(/^- /gm) ?? []).length;
  }
  let testsAdded = 0;
  let testLoc = 0;
  let srcLoc = 0;
  for (let page = 1; page <= 3; page += 1) {
    const files = api(`pulls/${p.number}/files`, "-f", "per_page=100", "-f", `page=${page}`);
    for (const f of files) {
      if (!f.filename.endsWith(".ts")) continue;
      if (/\.(test|spec)\.ts$/.test(f.filename)) {
        testLoc += f.additions;
        testsAdded += (f.patch?.match(/^\+\s*(?:it|test)(?:\.each)?\(/gm) ?? []).length;
      } else srcLoc += f.additions;
    }
    if (files.length < 100) break;
  }
  rows.push({
    pr: p.number,
    issue,
    runs: mine.length,
    ci,
    syncs,
    empty,
    noChange,
    testsLines,
    testsAdded,
    testLoc,
    srcLoc,
  });
}

const show = (v) => (v === null ? "-" : String(v));
const ratio = (a, b) => (b === 0 || b === null ? "-" : (a / b).toFixed(1));
console.log(`# Delivery counters, PRs merged since ${since} (${rows.length})\n`);
console.log(
  "| PR | Issue | Runs | ci lines | syncs | empty builds | no-change fixes | Tests lines | tests added | tests/line | test/src LOC |",
);
console.log("| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: |");
for (const r of rows) {
  console.log(
    `| #${r.pr} | ${r.issue ? `#${r.issue}` : "-"} | ${r.runs} | ${r.ci} | ${r.syncs} | ${r.empty} | ${r.noChange} | ${show(r.testsLines)} | ${r.testsAdded} | ${ratio(r.testsAdded, r.testsLines)} | ${ratio(r.testLoc, r.srcLoc)} |`,
  );
}
const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
console.log(
  `\nTotals: ci lines ${sum("ci")}, syncs ${sum("syncs")}, empty builds ${sum("empty")}, no-change fixes ${sum("noChange")}, tests added ${sum("testsAdded")} over ${sum("testsLines")} Tests lines, test/src LOC ${ratio(sum("testLoc"), sum("srcLoc"))}.`,
);

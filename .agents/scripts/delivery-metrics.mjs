#!/usr/bin/env node
// What delivery costs, per merged PR, from Claude Code's transcripts on this machine and from
// GitHub, so a later run can be compared with an earlier one.
//
//   node .agents/scripts/delivery-metrics.mjs [--end <iso time>] [--days 14] [--json]
//        [--prs <n,n,...>] [--repo <owner/name>] [--transcripts <glob>] [--sleep <file>]
//        [--input <file.json>]
//
// Without --prs it prints, for the PRs merged and delivered in the --days days before --end
// (default: now): the twelve headline metrics with their 95% intervals
// (delivery-metrics-stats.mjs), one row per stage, and the autonomy numbers
// (delivery-metrics-autonomy.mjs). The definitions are in delivery-metrics-prs.mjs.
//
// --prs prints one row per named PR instead, whenever it merged within the days read: wall
// minutes, agent-minutes and USD by stage, tokens by kind, sub-agent runs by kind, review
// passes, slow-lane starts and outcomes, fix runs and typed maintainer messages.
//
// --transcripts names the project folders to read, `*` allowed in the last part; the default is
// every folder under Claude Code's projects directory whose name holds the main checkout's.
// Transcripts changed in the 16 days before the window are read too, for work that started
// before it; GitHub is read up to --days after --end, for the bugs filed after the window. --repo is the repository on GitHub (default: GH_REPO, else the origin remote's).
// --sleep is where the sleep record is kept (default: delivery-metrics/sleep.json in the
// clone's git directory); run the script weekly or the record has gaps
// (delivery-metrics-sleep.mjs). --input reads `{ prs, issues, comments, pendingDecisions }`
// from a file instead of GitHub; without `issues` the autonomy numbers are left out.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { repository } from "./cli-args.mjs";
import { autonomy } from "./delivery-metrics-autonomy.mjs";
import { autonomyData, mergedPrs, withFiles } from "./delivery-metrics-github.mjs";
import { indexTranscripts } from "./delivery-metrics-index.mjs";
import { PRICES, deliveredPrs } from "./delivery-metrics-prs.mjs";
import { awakeClock, recordedSleep } from "./delivery-metrics-sleep.mjs";
import { bugsAfter, byStage, headline } from "./delivery-metrics-stats.mjs";
import { reportText, roundedRow } from "./delivery-metrics-text.mjs";
import { projectsRoot } from "./transcripts.mjs";

const DAY = 24 * 60 * 60 * 1000;
const EARLIER_WORK_DAYS = 16;
const EARLIER_PRS_DAYS = 28;

const { values: options } = parseArgs({
  options: {
    end: { type: "string" },
    days: { type: "string", default: "14" },
    prs: { type: "string" },
    repo: { type: "string" },
    transcripts: { type: "string" },
    sleep: { type: "string" },
    input: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const end = options.end === undefined ? Date.now() : Date.parse(options.end);
const days = Number(options.days);
const numbers = options.prs === undefined ? null : options.prs.split(",").map(Number);
if (Number.isNaN(end) || !(days > 0) || numbers?.some((n) => !Number.isInteger(n))) {
  console.error(
    "usage: delivery-metrics.mjs [--end <iso time>] [--days 14] [--json] [--prs <n,n,...>] [--repo <owner/name>] [--transcripts <glob>] [--sleep <file>] [--input <file.json>]",
  );
  process.exit(64);
}
const window = { from: end - days * DAY, to: end };
const inWindow = (iso) => Date.parse(iso) >= window.from && Date.parse(iso) < window.to;
const day = (t) => new Date(t).toISOString().slice(0, 10);

const github =
  options.input === undefined ? fetched() : JSON.parse(readFileSync(options.input, "utf8"));
const rows = await indexTranscripts(
  projectFolders(),
  Date.parse(day(window.from - EARLIER_WORK_DAYS * DAY)),
);
const sleep = recordedSleep(
  options.sleep ?? join(gitDirectory(), "delivery-metrics", "sleep.json"),
);
const delivered = deliveredPrs({
  rows,
  prs: github.prs,
  clock: awakeClock(rows, sleep),
  wanted: numbers === null ? (pr) => inWindow(pr.mergedAt) : (pr) => numbers.includes(pr.number),
});
const report = { ...(numbers === null ? windowReport() : prReport()), ...notes() };
console.log(options.json ? JSON.stringify(report, null, 2) : reportText(report));

function fetched() {
  const repo = options.repo ?? repository();
  const now = Math.min(Date.now(), window.to + days * DAY);
  const prs = mergedPrs(repo, window.from - EARLIER_PRS_DAYS * DAY, now);
  if (numbers === null) return { prs, ...autonomyData(repo, window.from, now) };
  return { prs: prs.map((pr) => (numbers.includes(pr.number) ? withFiles(repo, pr) : pr)) };
}

function gitDirectory() {
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function projectFolders() {
  const glob =
    options.transcripts ?? join(projectsRoot(), `*${basename(dirname(gitDirectory()))}*`);
  const shape = basename(glob)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  const folders = readdirSync(dirname(glob), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && new RegExp(`^${shape}$`).test(entry.name))
    .map((entry) => join(dirname(glob), entry.name));
  if (folders.length === 0) throw new Error(`No folder matches ${glob}; pass --transcripts`);
  return folders;
}

function windowReport() {
  const { list } = delivered;
  const hasIssues = Array.isArray(github.issues);
  const followUp = hasIssues
    ? bugsAfter({
        window,
        prs: github.prs,
        issues: github.issues,
        delivered: list,
        now: Date.now(),
      })
    : null;
  return {
    window: {
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
      days,
    },
    deliveredPrs: list.length,
    headline: headline(list, followUp),
    byStage: byStage(list),
    autonomy: hasIssues ? autonomy({ window, ...github }) : null,
  };
}

function prReport() {
  const found = new Set(delivered.list.map((p) => p.pr));
  for (const n of numbers.filter((number) => !found.has(number))) {
    console.error(
      `#${n}: not measured. It did not merge since ${day(window.from - EARLIER_PRS_DAYS * DAY)} (move --end or raise --days), or no tagged run of it is in the transcripts (--transcripts).`,
    );
  }
  const order = (p) => numbers.indexOf(p.pr);
  return { prs: delivered.list.map(roundedRow).sort((a, b) => order(a) - order(b)) };
}

function notes() {
  return {
    prices: PRICES,
    unpricedModels: delivered.unpriced,
    sleepRecordedFrom: sleep.from === null ? null : new Date(sleep.from).toISOString(),
  };
}

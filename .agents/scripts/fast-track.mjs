#!/usr/bin/env node
// The bug fast track (delivery rule 17): the two checks that take a bug from its triage report
// to `main` without the maintainer's `bug:ready`. Both read facts, never an agent's confidence.
//
//   node .agents/scripts/fast-track.mjs <n>            entry check, after the triage report
//   node .agents/scripts/fast-track.mjs <n> --pr <m>   exit check, before the merge
//
// Entry passes when issue <n> is open, carries `bug:new`, has no assignee, has a
// `bug/<n>-repro` branch, its newest triage report says `yes` on all five Fast track lines
// (`FAST_TRACK` in body-rules.mjs) and was posted from an account that can write to the repo
// (an agent posts under a maintainer's), and every comment after that report is an agent's
// from such an account. It then
// adds `bug:ready` and `fast-track`, removes `bug:new`, prints `fast-track: #<n> is bug:ready`
// and exits 0. Otherwise it changes nothing, prints `fast-track: #<n> held: <reasons>` and
// exits 1.
//
// Exit has nothing to check, and exits 0, unless issue <n> carries `fast-track`. Then PR <m>
// passes when it changes at most MAX_LINES lines in at most MAX_FILES files, touches no path in
// HOLD_PATHS (a surface file, the protocol version, an ADR), and has no `## Decision taken`
// comment; otherwise the same `held:` line and exit
// 1. `merge-pr.sh` runs it on every PR from a `bug/<n>` branch. The maintainer lets a held PR
// through by removing the `fast-track` label, or merges it by hand.
//
// It calls repo-scoped REST only, as merge-pr.sh does. The repo is GH_REPO, else the origin
// remote's owner/name.
import { execFileSync } from "node:child_process";

import { FAST_TRACK, fastTrackFacts, writtenByAgent } from "./body-rules.mjs";
import { option } from "./cli-args.mjs";

const MAX_LINES = 250;
const MAX_FILES = 8;
// why: the surface files docs-surface-check.mjs lists (the command tree, the config, the error
// table, the MCP tools, the HTTP sources, the client exports, the event map), the wire
// protocol's version and the ADRs. A fix that touches one may add to or break what a user
// meets, so it is the maintainer's to read before it merges.
const HOLD_PATHS = [
  [
    "a surface file",
    /^src\/(?:cli\/tree|core\/config|contract\/errors|mcp\/(?:server|contracts)|(?:client|admin)\/index|bus\/index)\.ts$/,
  ],
  ["a surface file", /^src\/http\/(?!.*\.test\.ts$)[^/]+\.ts$/],
  ["the protocol version", /^src\/contract\/protocol\.ts$/],
  ["an ADR", /^docs\/internal\/adr\//],
];
// why: a comment counts as an agent's, and a report as real, only from an account that can
// write to the repo; anyone can type the footer or a report's headings into a comment.
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const [number] = process.argv.slice(2);
const pr = option("--pr");
if (!/^\d+$/.test(number ?? "") || (process.argv.includes("--pr") && !/^\d+$/.test(pr ?? ""))) {
  console.error("usage: fast-track.mjs <n> [--pr <m>]");
  process.exit(64);
}
const nwo = repository();
const issue = api("GET", `issues/${number}`);
const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));

if (pr === null) entryCheck();
else exitCheck();

function entryCheck() {
  const holds = [];
  if (issue.state !== "open") holds.push("the issue is closed");
  if (!labels.includes("bug:new")) {
    holds.push(
      `it carries ${labels.filter((l) => /^\w+:/.test(l)).join(", ") || "no state label"}, not bug:new`,
    );
  }
  if (issue.assignees.length > 0) {
    holds.push(`it is assigned to ${issue.assignees.map((a) => a.login).join(", ")}`);
  }
  const comments = paged(`issues/${number}/comments`);
  const at = comments.findLastIndex((c) => fastTrackFacts(c.body) !== null);
  if (at === -1) holds.push("it has no triage report");
  else if (!WRITERS.has(comments[at].author_association)) {
    holds.push("its newest triage report is not from an account that can write to the repo");
  } else {
    holds.push(...factHolds(fastTrackFacts(comments[at].body)));
    const agents = (c) => WRITERS.has(c.author_association) && writtenByAgent(c.body);
    if (!comments.slice(at + 1).every(agents)) holds.push("a person commented after the report");
  }
  if (!exists(`branches/bug/${number}-repro`)) holds.push(`bug/${number}-repro does not exist`);
  if (holds.length > 0) held(holds);
  api("POST", `issues/${number}/labels`, "-f", "labels[]=bug:ready", "-f", "labels[]=fast-track");
  // why: the issue-state workflow removes the previous state label too; whoever is second
  // gets a 404, which is the state both want.
  exists(`issues/${number}/labels/bug:new`, "DELETE");
  console.log(`fast-track: #${number} is bug:ready`);
}

function factHolds(facts) {
  if (facts.map((f) => f.name).join("|") !== FAST_TRACK.join("|")) {
    return ["its report has no Fast track section with the five lines"];
  }
  return facts.filter((f) => !f.yes).map((f) => `${f.name}: no — ${f.why}`);
}

function exitCheck() {
  if (!labels.includes("fast-track")) {
    console.log(`fast-track: #${number} was not fast-tracked; nothing to check`);
    return;
  }
  const pull = api("GET", `pulls/${pr}`);
  const holds = [];
  const lines = pull.additions + pull.deletions;
  if (lines > MAX_LINES) holds.push(`PR #${pr} changes ${lines} lines, over ${MAX_LINES}`);
  if (pull.changed_files > MAX_FILES) {
    holds.push(`PR #${pr} changes ${pull.changed_files} files, over ${MAX_FILES}`);
  }
  const files = paged(`pulls/${pr}/files`).map((f) => f.filename);
  for (const [what, pattern] of HOLD_PATHS) {
    const hit = files.find((f) => pattern.test(f));
    if (hit !== undefined) holds.push(`PR #${pr} touches ${what} (${hit})`);
  }
  if (paged(`issues/${pr}/comments`).some((c) => /^## Decision taken\s*$/m.test(c.body ?? ""))) {
    holds.push(`PR #${pr} has a "Decision taken" comment`);
  }
  if (holds.length > 0) {
    held(holds, ` Remove the fast-track label from #${number} to let it merge.`);
  }
  console.log(`fast-track: #${number} PR #${pr} passes the exit check`);
}

function held(holds, how = "") {
  console.error(`fast-track: #${number} held: ${holds.join("; ")}.${how}`);
  process.exit(1);
}

function paged(at) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = api("GET", at, "-f", "per_page=100", "-f", `page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

// why: a missing branch or label answers 404, which is an answer here, not a failure.
function exists(at, method = "GET") {
  try {
    execFileSync("gh", ["api", "-X", method, `repos/${nwo}/${at}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch (error) {
    if (/404|Not Found/.test(String(error.stderr))) return false;
    throw error;
  }
}

function api(method, at, ...extra) {
  return JSON.parse(
    execFileSync("gh", ["api", "-X", method, `repos/${nwo}/${at}`, ...extra], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function repository() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = /([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) throw new Error(`Cannot read owner/name from origin ${url}; set GH_REPO`);
  return `${match[1]}/${match[2]}`;
}

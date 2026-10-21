#!/usr/bin/env node
// `node .agents/scripts/instruction-reads.mjs [--since YYYY-MM-DD] [--role <stage/role>]`: how often
// each role's runs open each instruction file, from Claude Code's transcripts on this machine.
//
// A run is a ledger-tagged transcript (`toolchain.md`, "Review measurement"); its role is
// `<stage>/<role>`. A file counts as opened when any tool call of the run names it: a rule
// under docs/internal/agent-rules/, a brief under .agents/briefs/ (or the rules/ and briefs/
// copies a review's inputs directory holds), REVIEW.md, EXPLORATION.md, a flow doc, or a
// module manual (AGENTS.md). The agent's own definition is not a file it opens: the harness
// loads it. Prints one Markdown table per role: runs, then each file with the runs that
// opened it, most opened first. This is the number that judges a rewrite of the rules, the
// briefs or the router (PROCESS-REVIEW-2026-10-21.md, items 16 to 18).
import { runOf, taggedRuns } from "./transcripts.mjs";
import { option } from "./cli-args.mjs";

const since = option("--since");
const only = option("--role");
const sinceMs = since === null ? 0 : Date.parse(since);
if (since !== null && Number.isNaN(sinceMs)) {
  console.error("usage: instruction-reads.mjs [--since YYYY-MM-DD] [--role <stage/role>]");
  process.exit(64);
}

const FILE = new RegExp(
  String.raw`(?:docs/internal/agent-rules/[\w.-]+\.md|\.agents/briefs/[\w.-]+\.md|(?:^|["'\s/])(?:rules|briefs)/[\w.-]+\.md|review-protocol\.md|docs/internal/REVIEW\.md|docs/internal/EXPLORATION\.md|docs/internal/flows/[\w.-]+\.md|(?:src/[\w/.-]*)?AGENTS\.md)`,
  "g",
);

const byRole = new Map();
for (const { file, tag } of taggedRuns()) {
  if (tag.stage === "replay") continue;
  const role = `${tag.stage}/${tag.role}`;
  if (only !== null && role !== only) continue;
  const run = runOf(file);
  if (Date.parse(run.startedAt ?? "") < sinceMs) continue;
  const opened = new Set();
  for (const input of run.toolInputs) {
    for (const m of input.matchAll(FILE)) {
      opened.add(
        m[0]
          .replace(/^["'\s/]/, "")
          .replace(/^(?:rules|briefs)\//, (p) =>
            p === "rules/" ? "docs/internal/agent-rules/" : ".agents/briefs/",
          ),
      );
    }
  }
  const entry = byRole.get(role) ?? { runs: 0, files: new Map() };
  entry.runs += 1;
  for (const f of opened) entry.files.set(f, (entry.files.get(f) ?? 0) + 1);
  byRole.set(role, entry);
}

if (byRole.size === 0) {
  console.log(`No tagged runs${since ? ` since ${since}` : ""}.`);
  process.exit(0);
}
console.log(`# Instruction files opened per role${since ? `, runs since ${since}` : ""}\n`);
for (const [role, { runs, files }] of [...byRole].sort()) {
  console.log(`## ${role}: ${runs} runs\n`);
  console.log("| File | Runs that opened it |\n| --- | --: |");
  for (const [f, n] of [...files].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    console.log(`| ${f} | ${n}/${runs} |`);
  }
  console.log("");
}

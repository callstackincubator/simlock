#!/usr/bin/env node
// SubagentStop hook: a delivery stage agent may not stop before its last message is its report
// block. The block's first key names the agent:
//
//   implementer         issue: <N> ...
//   reviewer            PR: #<M>  Round: ...
//   hardware-verifier   PR: #<M>  Hardware: ...
//
// An implementer's `mode: audit` report must also hold its `audit:` line: an audit given fixes
// as well once did the fixes and skipped the audit. That line's `probed <p>/<t>` must show every
// test it added or changed probed: audits that skipped the probe left half of all review
// findings to the reviewers. Unless its Assessment is incomplete, an implementer's `cycles
// <b>/<t>` with b < t lists the t - b Tests lines not built under `remaining`, or an `open` line
// `spec needs: ...`; an audit's `donewhen <k>/<n>` or `covered <c>/<f>` short of its total has an
// `open` line per missing one. A reviewer's `Rerun:` is `round 2`, `fix-check` or `none`; its
// Spec, Code and Claims review counts are each `<n> findings (<b> blocking)` or `skipped`; and
// its `Findings file:` exists (relative paths from the agent's cwd). Other agents stop freely.
// Claude Code ends the turn anyway after eight blocks in a row.
import fs from "node:fs";
import path from "node:path";

const REPORT = {
  implementer: /^issue: \d+/m,
  reviewer: /^PR: #\d+\s+Round:/m,
  "hardware-verifier": /^PR: #\d+\s+Hardware:/m,
};

// why: each check returns its block reason or null; the first reason found is the one given.
const IMPLEMENTER_CHECKS = [
  cyclesDefect,
  auditCount("donewhen", "Done when line"),
  auditCount("covered", "changed function no test covers"),
];
const REVIEWER_CHECKS = [rerunDefect, lensCountsDefect, findingsFileDefect];

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const shape = REPORT[input.agent_type];
const message = input.last_assistant_message ?? "";
if (shape === undefined) process.exit(0);
let blocked = false;

if (!shape.test(message)) {
  block(
    "You stopped without your report block. If a helper agent or a command you started is " +
      "still running, wait for it in the foreground. Then finish the work and end with the " +
      "report block your instructions define, and nothing after it.",
  );
} else if (
  input.agent_type === "reviewer" &&
  !/^Assessment: (complete|incomplete)\b/m.test(message)
) {
  block(
    "Report Assessment: complete or incomplete with missing scope; budget exhaustion is not a pass.",
  );
} else if (input.agent_type === "reviewer" && reviewerDefect() !== null) {
  block(reviewerDefect());
} else if (/\bmode: audit\b/.test(message) && !/^Assessment: incomplete\b/m.test(message)) {
  const audit = /^audit: .*$/m.exec(message);
  const probed = audit === null ? null : /\bprobed (\d+)\/(\d+)/.exec(audit[0]);
  if (audit === null) {
    block(
      "Your report is an audit's but has no `audit:` line, so the audit did not run. Do the " +
        "audit in implement-audit.md on the whole diff, then report again with its `audit:` line.",
    );
  } else if (probed === null) {
    block(
      "Your `audit:` line has no `probed` count. Probe every test you added or changed as " +
        "implement-audit.md says, then report again with `probed <probed>/<tests>`.",
    );
  } else if (Number(probed[1]) < Number(probed[2])) {
    block(
      `You probed ${probed[1]} of ${probed[2]} tests. Probe the rest as implement-audit.md ` +
        "says: break the code each covers, run its file, see it fail on its assertion, restore.",
    );
  }
}

if (!blocked && input.agent_type === "implementer" && !/^Assessment: incomplete\b/m.test(message)) {
  const defect = implementerDefect();
  if (defect !== null) block(defect);
}

function implementerDefect() {
  return firstDefect(IMPLEMENTER_CHECKS);
}

function reviewerDefect() {
  return firstDefect(REVIEWER_CHECKS);
}

function firstDefect(checks) {
  for (const check of checks) {
    const defect = check();
    if (defect !== null) return defect;
  }
  return null;
}

function cyclesDefect() {
  const cycles = /\bcycles: (\d+)\/(\d+)/.exec(message);
  const missing = cycles === null ? 0 : Number(cycles[2]) - Number(cycles[1]);
  if (missing <= 0 || items("remaining").length >= missing) return null;
  if (items("open").some((l) => l.startsWith("spec needs:"))) return null;
  return (
    `Your report says \`cycles ${cycles[1]}/${cycles[2]}\`: list the ${missing} Tests lines not ` +
    "built under `remaining`, in build order, or name what stops them under `open` as " +
    "`spec needs: <line>`."
  );
}

function auditCount(name, what) {
  return () => {
    const audit = /^audit: .*$/m.exec(message)?.[0] ?? "";
    const count = new RegExp(`\\b${name} (\\d+)/(\\d+)`).exec(audit);
    if (count === null || items("open").length >= Number(count[2]) - Number(count[1])) return null;
    return (
      `Your \`audit:\` line says \`${name} ${count[1]}/${count[2]}\`: give each ${what} left ` +
      "under `open`, with why, or finish it and count it."
    );
  };
}

function rerunDefect() {
  if (/^Rerun: (?:round 2|fix-check|none)\s*$/m.test(message)) return null;
  return "Your report's `Rerun:` line is `round 2`, `fix-check` or `none`. Report again with it.";
}

function lensCountsDefect() {
  const lens = ["Spec", "Code", "Claims"].find(
    (l) => !/^(?:\d+ findings? \(\d+ blocking\)|skipped)$/.test(lensCount(l)),
  );
  if (lens === undefined) return null;
  return (
    `Your report's \`${lens} review:\` is \`<n> findings (<b> blocking)\` or \`skipped\`. ` +
    "Report again with the counts."
  );
}

function lensCount(lens) {
  const value = new RegExp(
    `\\b${lens} review: (.+?)(?=\\s+(?:Spec|Code|Claims) review:|\\s*$)`,
    "m",
  ).exec(message)?.[1];
  return value ?? "";
}

function findingsFileDefect() {
  const file = /^Findings file: *(.*?)\s*$/m.exec(message)?.[1] ?? "";
  const needed = file !== "" || /^Assessment: complete\b/m.test(message);
  if (!needed || (file !== "" && fs.existsSync(path.resolve(input.cwd ?? ".", file)))) return null;
  return (
    "Your report's `Findings file:` names no file on disk. Write the findings file REVIEW.md " +
    '"Measurement" describes and report its path.'
  );
}

// why: a list key holds an inline value, or items indented under it; `none` is empty.
function items(key) {
  const lines = message.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at === -1) return [];
  const inline = lines[at].slice(key.length + 1).trim();
  const out = inline === "" || inline === "none" ? [] : [inline];
  for (const l of lines.slice(at + 1)) {
    if (!/^\s{2,}\S/.test(l)) break;
    if (l.trim() !== "none") out.push(l.trim());
  }
  return out;
}

function block(reason) {
  blocked = true;
  console.log(JSON.stringify({ decision: "block", reason }));
}

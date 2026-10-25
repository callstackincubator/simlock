#!/usr/bin/env node
// `node .agents/scripts/adr-flip-check.mjs <commit>`: the coordinator's mechanical fix-check of
// an `adr: <nnnn> to Accepted` fix (the deliver skill, "Merging the stack"; delivery rule 10).
// It passes (exit 0, `adr-flip: ok <nnnn> ...`) when <commit> changes only ADR files and, in
// each, only the `- **Status:**` item (its line and the indented lines that continue it), now
// reading `Accepted` and not "not yet implemented"; and in `docs/internal/adr/README.md` only
// index rows, at most one per ADR the commit flips, each the row of one of them. Anything else
// exits 1 with one `adr-flip: <path>: <what>` line per defect, and the coordinator sends the
// fix back instead of recording `verified by: coordinator`.
import { execFileSync } from "node:child_process";

const commit = process.argv[2];
if (commit === undefined) {
  console.error("usage: adr-flip-check.mjs <commit>");
  process.exit(64);
}
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 }).replace(/\r/g, "");
const ADR = /^docs\/internal\/adr\/(\d{4})-[^/]+\.md$/;
const INDEX = "docs/internal/adr/README.md";

const changed = git("diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", commit)
  .split("\n")
  .filter(Boolean)
  .map((row) => row.split("\t"));
const defects = [];
const flipped = [];
for (const [status, path] of changed) {
  if (!ADR.test(path) && path !== INDEX) {
    defects.push(`${path}: not an ADR file`);
  } else if (status !== "M") {
    defects.push(`${path}: ${status === "A" ? "added" : "deleted"}, not edited`);
  } else if (path !== INDEX) {
    const before = git("show", `${commit}^:${path}`);
    const after = git("show", `${commit}:${path}`);
    const line = statusItem(after)[0] ?? "";
    if (withoutStatus(before) !== withoutStatus(after)) {
      defects.push(`${path}: changes more than its Status line`);
    } else if (
      !/^- \*\*Status:\*\* Accepted\b/.test(line) ||
      /not yet implemented/.test(statusItem(after).join(" "))
    ) {
      defects.push(`${path}: its Status does not read Accepted: "${line.slice(0, 60)}"`);
    } else {
      flipped.push(ADR.exec(path)[1]);
    }
  }
}
if (changed.some(([, path]) => path === INDEX)) {
  const before = git("show", `${commit}^:${INDEX}`).split("\n");
  const after = git("show", `${commit}:${INDEX}`).split("\n");
  const rows = after.filter((l, i) => l !== before[i]);
  if (before.length !== after.length) {
    defects.push(`${INDEX}: adds or removes lines`);
  } else if (
    rows.length > flipped.length ||
    rows.some((l) => !flipped.some((n) => l.startsWith(`| [${n}]`)))
  ) {
    defects.push(`${INDEX}: changes a line that is not the index row of an ADR this commit flips`);
  }
}
if (flipped.length === 0 && defects.length === 0) defects.push(`${commit}: flips no ADR`);
for (const d of defects) console.log(`adr-flip: ${d}`);
if (defects.length > 0) process.exit(1);
console.log(`adr-flip: ok ${flipped.join(" ")}`);

function statusItem(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("- **Status:**"));
  if (at === -1) return [];
  const end = lines.findIndex((l, i) => i > at && !/^\s+\S/.test(l));
  return lines.slice(at, end === -1 ? lines.length : end);
}

function withoutStatus(text) {
  const item = statusItem(text);
  return item.length === 0 ? text : text.replace(item.join("\n"), "");
}

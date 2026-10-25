#!/usr/bin/env node
// `node .agents/scripts/issue-body.mjs <n> [--pr] [--dry-run] <op> ...`: edits one issue's or
// PR's body in place, so nobody rewrites a body by hand to change one line.
//
//   replace <old> <new>          <old> must occur exactly once, else exit 1 saying how often
//   set-section <heading> <file> the section becomes the file's text under the same heading
//   get-section <heading>        prints the section's text, without its heading line
//   append <file>                adds the file's text at the end
//
// <old>, <new> may be `@<file>` to read the text from a file; a file's one trailing newline is
// dropped. A section runs from its heading line to the next heading of the same or a higher
// level, code blocks skipped. <heading> `Status` matches `## Status` or `### Status`; `###
// Status` matches that level only. Two matches: exit 1. A missing section is created as `##
// <heading>` (or the level given) at the end. The body's last line stays `*Written by an
// agent.*` (`_Written by an agent._` is kept as it is), added when missing, and the end of the
// body means just above it.
//
// Refuses (exit 1) to touch an issue labelled `request:*` or `bug:*`: its body is the reporter's
// (delivery rule 5); a PR is never refused. `--pr` says <n> is a PR; a mismatch exits 2. Before
// writing it reads the body again and exits 1 when someone changed it meanwhile. Prints `updated
// #<n>`, or `unchanged #<n>`. `--dry-run` prints the new body and writes nothing. `--body-file
// <f>` reads the body from a file instead of GitHub and implies --dry-run (an offline test).
// Usage errors exit 2. Writes through REST, PATCH issues/<n>; the repo is GH_REPO, else the
// origin remote's owner/name.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FOOTER = "*Written by an agent.*";
const IS_FOOTER = /^[*_]Written by an agent\.[*_]$/;
const USAGE =
  "usage: issue-body.mjs <n> [--pr] [--dry-run] [--body-file <f>] replace <old> <new> | set-section <heading> <file> | get-section <heading> | append <file>";

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  if (at === -1) return false;
  argv.splice(at, 1);
  return true;
};
const isPr = flag("--pr");
let dryRun = flag("--dry-run");
let bodyFile = null;
const fileAt = argv.indexOf("--body-file");
if (fileAt !== -1) {
  bodyFile = argv[fileAt + 1] ?? null;
  argv.splice(fileAt, 2);
  dryRun = true;
}
const [n, op, ...rest] = argv;
const arity = { replace: 2, "set-section": 2, "get-section": 1, append: 1 };
if (
  n === undefined ||
  !/^\d+$/.test(n) ||
  !(op in arity) ||
  rest.length !== arity[op] ||
  (fileAt !== -1 && bodyFile === null)
) {
  usage();
}

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const nwo = () =>
  process.env.GH_REPO ??
  run("git", ["remote", "get-url", "origin"])
    .trim()
    .replace(/\.git$/, "")
    .replace(/.*[/:]([^/:]+\/[^/]+)$/, "$1");
// why: a cloud session's GitHub proxy refuses GraphQL, which `gh issue edit` and `gh pr edit`
// use; issues/<n> on REST reads and writes a PR's body as well as an issue's.
const fetchIssue = () => JSON.parse(run("gh", ["api", "-X", "GET", `repos/${nwo()}/issues/${n}`]));

let original;
if (bodyFile !== null) {
  original = readFileSync(bodyFile, "utf8");
} else {
  const issue = fetchIssue();
  const pull = issue.pull_request !== undefined;
  if (pull !== isPr) {
    console.error(`issue-body: #${n} is ${pull ? "a PR: pass --pr" : "an issue: drop --pr"}`);
    process.exit(2);
  }
  const reporter = (issue.labels ?? []).map((l) => l.name).find((l) => /^(request|bug):/.test(l));
  if (!pull && reporter !== undefined) {
    die(
      `refusing: #${n} is labelled ${reporter}, and its body stays the reporter's (delivery rule 5); post a comment instead`,
    );
  }
  original = issue.body ?? "";
}

const { main, footer } = split(original);
let next = main;
if (op === "replace") {
  const [old, now] = rest.map(text);
  if (old === "") die("<old> is empty");
  const count = main.split(old).length - 1;
  if (count !== 1) die(`<old> occurs ${count} times in #${n}'s body; it must occur once`);
  next = main.replace(old, () => now);
} else if (op === "append") {
  next = joined([main, text(`@${rest[0]}`).trim()]);
} else {
  const want = target(rest[0]);
  const lines = main.split("\n");
  const found = headings(lines).filter(
    (h) =>
      h.text === want.text &&
      (want.level === null ? h.level === 2 || h.level === 3 : h.level === want.level),
  );
  if (found.length > 1) {
    die(`${found.length} sections are headed "${want.text}"; name its level: "### ${want.text}"`);
  }
  const at = found[0];
  if (op === "get-section") {
    if (at === undefined) die(`no section headed "${want.text}" in #${n}'s body`);
    console.log(
      lines
        .slice(at.at + 1, end(lines, at))
        .join("\n")
        .trim(),
    );
    process.exit(0);
  }
  let content = text(`@${rest[1]}`).replace(/\s+$/, "");
  const first = /^\s*(#{1,6})\s+(.*\S)\s*(?:\n|$)/.exec(content);
  if (first !== null && first[2] === want.text) content = content.slice(first[0].length);
  const level = at?.level ?? want.level ?? 2;
  const section = joined([`${"#".repeat(level)} ${want.text}`, content.trim()]);
  next =
    at === undefined
      ? joined([main, section])
      : joined([lines.slice(0, at.at).join("\n"), section, lines.slice(end(lines, at)).join("\n")]);
}

const body = joined([next.replace(/\s+$/, ""), footer]);
if (dryRun) {
  console.log(body);
  process.exit(0);
}
if (body === original.replace(/\r/g, "")) {
  console.log(`unchanged #${n}`);
  process.exit(0);
}
if ((fetchIssue().body ?? "") !== original) {
  die(`#${n}'s body changed while this edit was being made; run it again`);
}
const dir = mkdtempSync(join(tmpdir(), "issue-body-"));
try {
  const payload = join(dir, "body.json");
  writeFileSync(payload, JSON.stringify({ body }));
  run("gh", ["api", "-X", "PATCH", `repos/${nwo()}/issues/${n}`, "--input", payload]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`updated #${n}`);

function usage() {
  console.error(USAGE);
  process.exit(2);
}

function die(message) {
  console.error(`issue-body: ${message}`);
  process.exit(1);
}

function text(value) {
  if (!value.startsWith("@")) return value;
  return readFileSync(value.slice(1), "utf8").replace(/\r/g, "").replace(/\n$/, "");
}

function split(raw) {
  const lines = raw.replace(/\r/g, "").replace(/\s+$/, "").split("\n");
  const last = (lines.at(-1) ?? "").trim();
  if (IS_FOOTER.test(last)) {
    return { main: lines.slice(0, -1).join("\n").replace(/\s+$/, ""), footer: last };
  }
  return { main: lines.join("\n"), footer: FOOTER };
}

function joined(parts) {
  return parts
    .filter((p) => p.trim() !== "")
    .map((p) => p.replace(/^\n+|\s+$/g, ""))
    .join("\n\n");
}

function target(heading) {
  const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(heading);
  return h === null ? { level: null, text: heading.trim() } : { level: h[1].length, text: h[2] };
}

function headings(lines) {
  const out = [];
  let fence = false;
  lines.forEach((l, at) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence) {
      const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(l);
      if (h !== null) out.push({ at, level: h[1].length, text: h[2] });
    }
  });
  return out;
}

function end(lines, at) {
  const after = headings(lines).find((h) => h.at > at.at && h.level <= at.level);
  return after === undefined ? lines.length : after.at;
}

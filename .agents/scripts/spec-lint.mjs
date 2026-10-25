#!/usr/bin/env node
// `node .agents/scripts/spec-lint.mjs [<issue>] [--feature] [--body-file <f>] [--parent-file <f>]
// [--world <f>]`: the structural half of the spec checker's categories, run before any checker
// starts and when a task gets `task:ready`. It reads the posted body (a task with its parent, a
// feature with its sub-issues) and prints one line per finding, `B <n> <section>: <what, and
// what to do>` for a blocking one and `N ...` for a note, where <n> is the issue the line is
// about (`-` for a draft with no number yet). Then `spec-lint: <b> blocking, <k> notes`; exit 1
// when anything blocks, 2 on a usage error.
//
// A task (task template, delivery rule 7, toolchain "Slow lane" and "Contract shapes"):
//   - `Part of #N.` first, equal to the GitHub parent; then `## Scope`, `## In short`, `##
//     Technical spec` with `### Facts`, `### Modules touched`, (`### Surface and extension
//     points`), `### Contract and event changes`, `### Other code on the same state`, `###
//     Failure modes`, `### Rules in play`, `### Tests`, then `## Done when`, `## Out of scope`,
//     `## Depends on`, in that order; the last line is the agent footer;
//   - no template leftovers: `#NNN`, a row of `...` cells, a `- ...` bullet, a template comment;
//   - In short holds a mermaid block;
//   - Facts holds `Commit <sha>.`, unique F numbers (a note when out of order), and a Source in
//     every row that is not docs, memory, "to re-check" or empty (docs alone is a note when the
//     Fact names code); every `path:line[-line]` in Facts, Modules touched and Rules in play
//     (a backticked `:line` takes the path before it) is a file at that commit with that many
//     lines. A path may be a unique suffix (`state/inbox.ts`). `node_modules/...` and
//     `v<version>:<path>` are another tool's source and are skipped; any other path this repo
//     lacks blocks;
//   - Modules touched and Other code on the same state each name their searches; more than 20
//     distinct `src/<module>/` paths need a Scope line saying why it cannot split;
//   - Contract and event changes is `none`, or says `bumps the protocol by one`; it never names
//     a protocol version, and names `EVENTS.md` when it names an event;
//   - Failure modes is a `Call | Outcome | What happens | Limit, counted from` table, or none;
//   - Tests opens with a line naming an existing test file; more than 10 bullets is a note and
//     more than 30 blocks, unless Scope says why it cannot split; with the parent read, its
//     Behaviours rows for this task number the Tests bullets;
//   - a Done when line about the slow lane, a real device or "on a Mac with" names an
//     `e2e/slow-*.test.ts` that exists, or that Modules touched adds.
// A feature (feature template, spec-session step 7): `Request: #N` or `Request: none`, then its
// sections in template order and the footer, no leftovers; How it works holds a mermaid block;
// Words used is not empty; Open questions is empty or `none` once `feature:planned` (or
// closed); per sub-issue, its Behaviours rows equal its Tests bullets, each bullet shares 60% of
// its words with one of its rows, every Task cell names a sub-issue; over the open sub-issues,
// each Depends on number exists, a closed one is a note, an open issue of another feature is a
// `depends-outside` note, a cycle blocks, and `chain <k> of <t> tasks` is printed.
//
// `--feature` reads <issue> as a feature (also when its body starts with `Request:`).
// `--body-file` reads the body from a file and `--parent-file` the parent's; either one, or
// `--world <f>` (the issues as JSON, see spec-body.mjs), reads nothing from GitHub, so a draft
// can be checked before it is posted. Paths resolve in the git repository of the working
// directory, which needs the body's commit. The repo is GH_REPO, else the origin remote.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bullets,
  cells,
  dependsOn,
  graph,
  IS_FOOTER,
  issues,
  printFinding,
  prose,
  readWorld,
  section,
  splitBody,
  stripComments,
  tables,
} from "./spec-body.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TASK_H2 = ["Scope", "In short", "Technical spec", "Done when", "Out of scope", "Depends on"];
const TASK_H3 = [
  "Facts",
  "Modules touched",
  "Surface and extension points",
  "Contract and event changes",
  "Other code on the same state",
  "Failure modes",
  "Rules in play",
  "Tests",
];
const OPTIONAL = new Set(["Surface and extension points"]);
const FEATURE_H2 = [
  "Problem",
  "Who it is for",
  "Outcome",
  "How it works for the user",
  "Examples",
  "What could go wrong",
  "Words used",
  "Non-goals",
  "Completion conditions",
  "Open questions",
  "Decisions",
  "Shared values",
  "Behaviours",
  "Tasks",
];
const FAILURE_HEADER = ["Call", "Outcome", "What happens", "Limit, counted from"];
const CANNOT_SPLIT =
  /\b(cannot|can't|can not|does not|doesn't|won't) split\b|\bone task, not\b|\bkept? (it )?whole\b/i;
const HARDWARE = /slow lane|real (simulator|emulator|device|iPhone|phone)|on a Mac with/i;
const SLOW_TEST = /e2e\/slow-[\w-]+\.test\.ts/g;
const EXTENSIONS =
  "ts|tsx|js|mjs|cjs|json|jsonc|md|mdx|yml|yaml|sh|swift|kt|kts|java|toml|txt|html|css|plist|py|xml|gradle";
const PATH_LINE = new RegExp(
  `^(v\\d[\\w.-]*:)?([\\w@./-]*[\\w@-]\\.(?:${EXTENSIONS})):(\\d+)(?:-(\\d+))?$`,
);
const PLAIN_PATH_LINE = new RegExp(
  `(?<![\\w/.@-])((?:[\\w@.-]+/)+[\\w@.-]+\\.(?:${EXTENSIONS})):(\\d+)(?:-(\\d+))?`,
  "g",
);
const DOC_PATH = /\.(md|mdx)\b/;
const CODE_PATH = new RegExp(`\\.(?!md\\b|mdx\\b)(?:${EXTENSIONS})\\b`);
const trees = new Map();
const counts = new Map();
const STOP = new Set(
  "the a an and or of to in on at by for with from is are be it its as that this then than when one each no not into after before same their them they any all per but if so via while".split(
    " ",
  ),
);

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  if (at === -1) return false;
  argv.splice(at, 1);
  return true;
};
const value = (name) => {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const v = argv[at + 1];
  if (v === undefined) usage();
  argv.splice(at, 2);
  return v;
};
const asFeature = flag("--feature");
const bodyFile = value("--body-file");
const parentFile = value("--parent-file");
const worldFile = value("--world");
if (argv.length > 1 || (argv.length === 1 && !/^\d+$/.test(argv[0]))) usage();
const number = argv.length === 1 ? Number(argv[0]) : null;
if (number === null && bodyFile === null) usage();
const offline = bodyFile !== null || parentFile !== null || worldFile !== null;
const world = offline ? (readWorld(worldFile) ?? {}) : null;

const findings = [];
const add = (level, where, text, issue = number) =>
  findings.push({ level, issue, section: where, text });

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const git = (...a) => run("git", a);

const self = number === null ? null : (issues([number], world).get(number) ?? null);
if (bodyFile === null && self === null) {
  console.error(`spec-lint: #${number} does not exist`);
  process.exit(2);
}
const body = bodyFile === null ? self.body : readFileSync(bodyFile, "utf8");
const parsed = splitBody(body);
const isFeature = asFeature || /^\s*Request:/.test(body);

checkLeftovers();
checkFooter();
if (isFeature) lintFeature();
else lintTask();

for (const f of findings.filter((x) => x.level === "B")) printFinding(f);
for (const f of findings.filter((x) => x.level === "N")) printFinding(f);
const blocking = findings.filter((f) => f.level === "B").length;
console.log(`spec-lint: ${blocking} blocking, ${findings.length - blocking} notes`);
process.exit(blocking > 0 ? 1 : 0);

function usage() {
  console.error(
    "usage: spec-lint.mjs [<issue>] [--feature] [--body-file <f>] [--parent-file <f>] [--world <f>]",
  );
  process.exit(2);
}

function text(s) {
  return s === undefined ? "" : prose(s.lines).join("\n").trim();
}

function h3Within(name) {
  const parent = section(parsed, name, 2);
  if (parent === undefined) return [];
  const end = parent.at + parent.lines.length;
  return parsed.sections.filter((s) => s.level === 3 && s.at > parent.at && s.at <= end);
}

function checkOrder(found, expected, where, prefix) {
  const titles = found.map((s) => s.title);
  let last = -1;
  for (const name of expected) {
    const at = titles.indexOf(name);
    if (at === -1) {
      if (!OPTIONAL.has(name)) add("B", where, `\`${prefix} ${name}\` is missing; add it`);
    } else if (at < last) {
      add("B", where, `\`${prefix} ${name}\` is out of template order; move it`);
    } else {
      last = at;
    }
  }
  for (const t of titles.filter((x) => !expected.includes(x))) {
    add("N", where, `\`${prefix} ${t}\` is not a template section`);
  }
}

function templateComments() {
  const out = [];
  for (const name of ["task.md", "feature.md"]) {
    const raw = readFileSync(join(ROOT, "docs", "internal", "templates", name), "utf8");
    for (const m of raw.matchAll(/<!--([\s\S]*?)-->/g)) out.push(squash(m[1]).slice(0, 40));
  }
  return out;
}

function squash(s) {
  return s.replace(/\s+/g, " ").trim();
}

function checkTemplateComments() {
  const known = templateComments();
  for (const m of body.matchAll(/<!--([\s\S]*?)-->/g)) {
    const start = squash(m[1]).slice(0, 40);
    if (start !== "" && known.includes(start)) {
      add("B", "body", `template comment "${start}…" is still there; delete it`);
    }
  }
}

function checkLeftovers() {
  checkTemplateComments();
  const lines = prose(body.split("\n"));
  if (lines.some((l) => /#NNN\b/.test(l))) add("B", "body", "`#NNN` placeholder; name the issue");
  if (lines.some((l) => /^\s*[-*]\s+\.\.\.\s*$/.test(l))) {
    add("B", "body", "a `- ...` placeholder bullet; fill it in or delete it");
  }
  if (lines.some((l) => /^\s*\|/.test(l) && cells(l).every((c) => c === "..." || c === ""))) {
    add("B", "body", "a table row of `...` cells; fill it in or delete it");
  }
}

function checkFooter() {
  const last = body.replace(/\s+$/, "").split("\n").at(-1)?.trim() ?? "";
  if (!IS_FOOTER.test(last)) add("B", "body", "the last line is not `*Written by an agent.*`");
}

function lacksMermaid(s) {
  return s !== undefined && !s.lines.some((l) => /^\s*```mermaid\s*$/.test(l));
}

function lintTask() {
  const tech = h3Within("Technical spec");
  checkOrder(
    parsed.sections.filter((s) => s.level === 2),
    TASK_H2,
    "body",
    "##",
  );
  checkOrder(tech, TASK_H3, "Technical spec", "###");
  checkPartOf();
  if (lacksMermaid(section(parsed, "In short", 2))) {
    add("B", "In short", "no ```mermaid block; add the small diagram the template asks for");
  }
  const sha = checkCommit();
  checkFacts();
  for (const name of ["Facts", "Modules touched", "Rules in play"]) checkPaths(name, sha);
  checkSearches("Modules touched");
  checkSearches("Other code on the same state");
  checkModuleCount();
  checkContract();
  checkFailureModes();
  checkTests(sha);
  checkHardware(sha);
  checkOwnBehaviours();
}

function checkPartOf() {
  const first = parsed.preamble.map((l) => l.trim()).find((l) => l !== "") ?? "";
  const m = /^Part of #(\d+)\.?$/.exec(first);
  if (m === null) {
    add("B", "body", "the first line is not `Part of #<feature>.`");
    return;
  }
  if (self === null) return;
  if (self.parent !== Number(m[1])) {
    const actual = self.parent === null ? "no parent" : `#${self.parent}`;
    add("B", "body", `\`Part of #${m[1]}\` but GitHub's parent is ${actual}; make them agree`);
  }
}

function canSplitReason() {
  return CANNOT_SPLIT.test(text(section(parsed, "Scope", 2)));
}

function checkCommit() {
  const m = /^Commit\b[^\n]*?\b([0-9a-f]{7,40})\b/m.exec(
    text(section(parsed, "Technical spec", 2)),
  );
  if (m === null) {
    add(
      "B",
      "Facts",
      "no `Commit <sha>.` line, so no path:line can be checked; add the commit read",
    );
    return null;
  }
  try {
    return git("rev-parse", "--verify", "--quiet", `${m[1]}^{commit}`).trim();
  } catch {
    add("B", "Facts", `commit ${m[1]} is not in this clone; fetch it, or cite one that is`);
    return null;
  }
}

function factRows() {
  const facts = section(parsed, "Facts", 3);
  if (facts === undefined) return [];
  return tables(facts.lines)
    .filter((t) => t.header[0] === "#")
    .flatMap((t) => t.rows)
    .filter((r) => /^F\d+$/.test(r[0]));
}

function checkSource(id, fact, source) {
  if (source === "" || source === "...") {
    add("B", "Facts", `${id} has no Source; cite the line or command it was read from`);
  } else if (/^(docs?|memory|to re-?check|tbd|todo)\.?$/i.test(source)) {
    add("B", "Facts", `${id}'s Source is "${source}", which is no source; cite the line read`);
  } else if (DOC_PATH.test(source) && !CODE_PATH.test(source) && /`/.test(fact)) {
    add("N", "Facts", `${id} names code but cites only docs; cite the code line`);
  }
}

function checkFacts() {
  const rows = factRows();
  const seen = new Set();
  let previous = 0;
  for (const row of rows) {
    const id = row[0];
    const n = Number(id.slice(1));
    if (seen.has(id)) add("B", "Facts", `${id} is used twice; renumber one`);
    else if (n < previous) add("N", "Facts", `${id} comes after F${previous}`);
    seen.add(id);
    previous = Math.max(previous, n);
    checkSource(id, row[1] ?? "", row.at(-1) ?? "");
  }
}

function ref(path, from, to, tool = false) {
  return { tool, path, from: +from, to: +(to ?? from) };
}

function backtickedRef(content, last) {
  const full = PATH_LINE.exec(content);
  if (full !== null) {
    const tool = full[1] !== undefined;
    return { found: ref(full[2], full[3], full[4], tool), last: tool ? null : full[2] };
  }
  const tail = /^:(\d+)(?:-(\d+))?$/.exec(content);
  if (tail === null || last === null) return { found: null, last };
  return { found: ref(last, tail[1], tail[2]), last };
}

function backtickedRefs(line) {
  const refs = [];
  let last = null;
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const next = backtickedRef(m[1], last);
    last = next.last;
    if (next.found !== null) refs.push(next.found);
  }
  return refs;
}

function plainRefs(line) {
  return [...line.replace(/`[^`]*`/g, " ").matchAll(PLAIN_PATH_LINE)].map((m) =>
    ref(m[1], m[2], m[3]),
  );
}

function pathRefs(lines) {
  return prose(lines).flatMap((line) => [...backtickedRefs(line), ...plainRefs(line)]);
}

function tree(sha) {
  if (!trees.has(sha)) {
    trees.set(sha, new Set(git("ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean)));
  }
  return trees.get(sha);
}

function resolvePath(sha, path, named = new Set()) {
  const files = tree(sha);
  const clean = path.replace(/^\.\//, "");
  if (files.has(clean)) return [clean];
  const found = [...files].filter((f) => f.endsWith(`/${clean}`));
  const preferred = found.filter((f) => named.has(f));
  return preferred.length === 1 ? preferred : found;
}

function namedPaths(lines) {
  return new Set(
    [
      ...prose(lines)
        .join("\n")
        .matchAll(/`([\w@./-]+\/[\w@.-]+)(?::[\d-]+)?`/g),
    ].map((m) => m[1]),
  );
}

function lineCount(sha, path) {
  const key = `${sha}:${path}`;
  if (!counts.has(key)) {
    const content = git("cat-file", "-p", key);
    counts.set(key, content.split("\n").length - (content.endsWith("\n") ? 1 : 0));
  }
  return counts.get(key);
}

function checkRef(where, sha, ref, named) {
  const shown = `${ref.path}:${ref.from}${ref.to === ref.from ? "" : `-${ref.to}`}`;
  if (ref.tool || ref.path.startsWith("node_modules/")) return;
  const found = resolvePath(sha, ref.path, named);
  if (found.length === 0) {
    add(
      "B",
      where,
      `\`${shown}\` is no file at ${sha.slice(0, 9)}; fix the path, or cite another tool as \`node_modules/<pkg>/...\` or \`v<version>:<path>\``,
    );
  } else if (found.length > 1) {
    add("N", where, `\`${shown}\` matches ${found.length} files; give the full path`);
  } else if (ref.to < ref.from || ref.to > lineCount(sha, found[0])) {
    add(
      "B",
      where,
      `\`${shown}\` is past the end of ${found[0]} (${lineCount(sha, found[0])} lines) at ${sha.slice(0, 9)}; fix the line`,
    );
  }
}

function checkPaths(name, sha) {
  const s = section(parsed, name, 3);
  if (s === undefined || sha === null) return;
  const named = namedPaths(s.lines);
  for (const ref of pathRefs(s.lines)) checkRef(name, sha, ref, named);
}

function checkSearches(name) {
  const s = section(parsed, name, 3);
  if (s !== undefined && !/\bsearch(es|ed)?\b/i.test(text(s))) {
    add("B", name, "no `Searches:` line; name the searches that found the list");
  }
}

function checkModuleCount() {
  const s = section(parsed, "Modules touched", 3);
  const modules = new Set([...text(s).matchAll(/\bsrc\/([\w-]+)\//g)].map((m) => m[1]));
  if (modules.size > 20 && !canSplitReason()) {
    add(
      "B",
      "Modules touched",
      `${modules.size} modules; split the task, or say under Scope why it cannot split`,
    );
  }
}

function eventNames() {
  const source = readFileSync(join(ROOT, "src", "bus", "index.ts"), "utf8");
  const map = /export interface EventMap \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  return new Set([...map.matchAll(/^ {2}"([a-z-]+\.[a-z-]+)":/gm)].map((m) => m[1]));
}

function checkContract() {
  const s = section(parsed, "Contract and event changes", 3);
  if (s === undefined) return;
  const t = text(s);
  if (/\bprotocol (version )?\d+|PROTOCOL_VERSION(_RANGE)?\b[^\n]*\d/i.test(t)) {
    add(
      "B",
      "Contract and event changes",
      "names a protocol version; say `this PR bumps the protocol by one`",
    );
  }
  if (/^(none|no contract|no shape)\b/i.test(t)) return;
  if (!/bumps the protocol by one/i.test(t)) {
    add(
      "B",
      "Contract and event changes",
      "a shape change without `this PR bumps the protocol by one`; add it, or start with `None`",
    );
  }
  const events = eventNames();
  const named = [...t.matchAll(/`([a-z-]+\.[a-z-]+)`/g)].some((m) => events.has(m[1]));
  if (named && !/EVENTS\.md/.test(t)) {
    add("B", "Contract and event changes", "names an event but not its `EVENTS.md` entry; add it");
  }
}

function checkFailureModes() {
  const s = section(parsed, "Failure modes", 3);
  if (s === undefined) return;
  const ok = tables(s.lines).some((t) => FAILURE_HEADER.every((h, i) => t.header[i] === h));
  if (!ok && !/^none\b/i.test(text(s))) {
    add(
      "B",
      "Failure modes",
      `no \`${FAILURE_HEADER.join(" | ")}\` table and not \`none\`; add the table`,
    );
  }
}

function existsAt(sha, path) {
  return resolvePath(sha ?? "HEAD", path).length > 0;
}

function checkSeam(s, sha) {
  const first = prose(s.lines).find((l) => l.trim() !== "") ?? "";
  if (first === "" || /^[-*] /.test(first)) {
    add("B", "Tests", "no seam line before the bullets; name the seam and a test file to model on");
    return;
  }
  const named = [...first.matchAll(/`([^`]+\.(?:test|spec)\.[a-z]+)(?::[\d-]+)?`/g)].map(
    (m) => m[1],
  );
  if (!named.some((p) => existsAt(sha, p))) {
    add(
      "B",
      "Tests",
      "the seam line names no test file that exists; name one to model the tests on",
    );
  }
}

function checkTests(sha) {
  const s = section(parsed, "Tests", 3);
  if (s === undefined) return;
  checkSeam(s, sha);
  const count = bullets(s.lines).length;
  if (canSplitReason()) return;
  if (count > 30)
    add("B", "Tests", `${count} lines; split the task, or say under Scope why it cannot split`);
  else if (count > 10) add("N", "Tests", `${count} lines, over about 10`);
}

function checkHardware(sha) {
  const done = section(parsed, "Done when", 2);
  if (done === undefined) return;
  const modules = text(section(parsed, "Modules touched", 3));
  for (const line of bullets(done.lines).filter((b) => HARDWARE.test(b))) {
    const named = [...line.matchAll(SLOW_TEST)].map((m) => m[0]);
    const short = line.length > 60 ? `${line.slice(0, 60)}…` : line;
    if (named.length === 0) {
      add(
        "B",
        "Done when",
        `"${short}" needs the slow lane but names no \`e2e/slow-*.test.ts\`; name it`,
      );
    } else if (!named.every((p) => existsAt(sha, p) || modules.includes(p))) {
      add(
        "B",
        "Done when",
        `"${short}" names a slow-lane test that does not exist and Modules touched does not add; fix the name`,
      );
    }
  }
}

function checkOwnBehaviours() {
  if (number === null) return;
  const parentBody =
    parentFile !== null
      ? readFileSync(parentFile, "utf8")
      : self.parent === null
        ? null
        : (issues([self.parent], world).get(self.parent)?.body ?? null);
  if (parentBody === null) return;
  const rows = behaviourRows(splitBody(parentBody));
  if (rows === null) return;
  checkTaskRows({ number, body }, rows);
}

function lintFeature() {
  const first = parsed.preamble.map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (!/^Request: (#\d+|none)\b/.test(first)) {
    add("B", "body", "the first line is not `Request: #<n>` or `Request: none`");
  }
  checkOrder(
    parsed.sections.filter((s) => s.level === 2),
    FEATURE_H2,
    "body",
    "##",
  );
  if (lacksMermaid(section(parsed, "How it works for the user", 2))) {
    add("B", "How it works for the user", "no ```mermaid block; add the user's flow");
  }
  const wordsUsed = section(parsed, "Words used", 2);
  if (wordsUsed !== undefined && text(wordsUsed) === "") {
    add("B", "Words used", "empty; list the terms, or write `none`");
  }
  checkOpenQuestions();
  if (self === null) return;
  const subs = [...issues(self.subIssues, world).values()];
  checkBehaviours(subs);
  checkGraph(subs);
}

function checkOpenQuestions() {
  const planned =
    self !== null && (self.labels.includes("feature:planned") || self.state === "closed");
  const t = stripComments(text(section(parsed, "Open questions", 2)));
  if (planned && t.trim() !== "" && !/^none\.?$/i.test(t.trim())) {
    add(
      "B",
      "Open questions",
      "not empty on a planned feature; settle them, or move the feature back to feature:spec",
    );
  }
}

function behaviourRows(p) {
  const s = section(p, "Behaviours", 2);
  if (s === undefined) return null;
  const table = tables(s.lines).find((t) => t.header.some((h) => h.startsWith("Task")));
  if (table === undefined) return null;
  const at = table.header.findIndex((h) => h.startsWith("Task"));
  return table.rows.map((r) => ({
    tasks: [...(r[at] ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
    behaviour: words(r[0] ?? ""),
    words: words(r.filter((_, i) => i !== at).join(" ")),
    cell: r[at] ?? "",
  }));
}

function words(s) {
  return new Set(
    s
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

function shared(a, b) {
  return [...a].filter((w) => b.has(w)).length;
}

// why: a line may spell out the cases its row only names ("object rows of Examples"), so it
// passes when it holds most of the row's Behaviour words, or most of the shorter of the two.
function overlap(line, row) {
  const byBehaviour =
    row.behaviour.size === 0 ? 0 : shared(row.behaviour, line) / row.behaviour.size;
  const shorter = Math.min(line.size, row.words.size);
  return Math.max(byBehaviour, shorter === 0 ? 0 : shared(line, row.words) / shorter);
}

function checkTaskRows(task, rows) {
  const tests = section(splitBody(task.body), "Tests", 3);
  if (tests === undefined) return;
  const own = rows.filter((r) => r.tasks.includes(task.number));
  const lines = bullets(tests.lines);
  if (own.length !== lines.length) {
    add(
      "B",
      "Behaviours",
      `#${task.number} has ${lines.length} Tests lines and ${own.length} Behaviours rows; one line per row`,
      task.number,
    );
  }
  lines.forEach((line, i) => {
    const best = Math.max(0, ...own.map((r) => overlap(words(line), r)));
    if (best < 0.6) {
      add(
        "N",
        "Tests",
        `line ${i + 1} shares ${Math.round(best * 100)}% of its words with its best Behaviours row; copy the row's words`,
        task.number,
      );
    }
  });
}

function checkBehaviours(subs) {
  const rows = behaviourRows(parsed);
  if (rows === null) {
    if (subs.length > 0) add("B", "Behaviours", "no Behaviours table with a Task column");
    return;
  }
  const numbers = new Set(subs.map((t) => t.number));
  for (const row of rows) {
    if (row.tasks.length === 0 || !row.tasks.every((n) => numbers.has(n))) {
      add("B", "Behaviours", `a row's Task cell "${row.cell}" names no sub-issue; name one`);
    }
  }
  for (const task of subs) {
    if (!rows.some((r) => r.tasks.includes(task.number))) {
      add("B", "Behaviours", `#${task.number} has no row; add its behaviours`);
    }
    checkTaskRows(task, rows);
  }
}

function checkGraph(tasks) {
  const deps = tasks.filter((t) => t.state === "open").flatMap((t) => dependsOn(t.body));
  const result = graph(tasks, issues(deps, world));
  findings.push(...result.findings);
  if (result.chain !== null && tasks.length > 0) {
    add("N", "Depends on", `chain ${result.chain} of ${tasks.length} tasks`);
  }
}

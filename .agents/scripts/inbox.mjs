#!/usr/bin/env node
// The maintainer's inbox: every open issue and PR that waits on a person, not on an agent, with
// the one action it needs, so nobody has to ask the repository what is waiting.
//
//   node .agents/scripts/inbox.mjs [--save] [--state <file>] [--input <file.json>]
//
// The first line is `Inbox: <n> items, <a> new, <g> gone. Changed: yes|no`, compared with the
// snapshot the last `--save` wrote (default: `inbox-state.json` in the clone's git directory, so
// every worktree shares it). Then one `## <section>` per section that has items, oldest first,
// each line `+ #<n> <age>d <label> | <action> | <title>`; `+` marks an item that is new in its
// section, and a last `Gone:` line names what left. The sections:
//
//   decide     a one-click decision: a triage report to read, a blocker to clear
//   prs        a PR to review, to merge by hand, to run on hardware, or a routine PR stuck in draft
//   sort       an issue with no <kind>:<state> label, which no automation sees
//   session    work that starts with a spec session: a request, an unfinished spec, a draft task
//   run        work an agent may start now: `deliver` on it
//   decisions  an issue, open or closed, whose body still marks a decision delivery took as
//              pending the maintainer
//   untriaged  a `bug:new` with no triage report; this one waits on an agent, not on a person
//
// A `task:draft` under a `feature:spec` feature is left out: its feature's line covers it.
//
// GitHub is read through repo-scoped REST only, as the other scripts do. --input reads the same
// data from a file instead: { now, me, issues: [{ number, title, state, labels, assignees,
// author, createdAt, body, parent, triaged, pr: null | { draft, head, updatedAt } }], runnable:
// { "<feature>": [<task>] } }. `parent` is the number of the issue it is a sub-issue of, or null.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { repository } from "./cli-args.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_LABEL = /^(request|bug|feature|task|refactor):/;
const PENDING = "(decided in delivery, pending the maintainer)";
const TRIAGE_REPORT = /^## Reproduction\b/;
// why: an ADR PR stays open and ready at the bottom of its feature's stack until the feature
// merges (delivery rule 15), so it waits on nobody.
const ADR_BRANCH = /^feature\/\d+-adr/;
const ROUTINE_BRANCH = /^chore\//;
const STUCK_DRAFT_DAYS = 3;
const SECTIONS = ["decide", "prs", "sort", "session", "run", "decisions", "untriaged"];

const ISSUE_RULES = [
  [(i) => i.state !== "open", null, ""],
  [(i) => i.labels.includes("upstream"), null, ""],
  [(i) => i.kindState?.endsWith(":blocked"), "decide", "read the handoff, clear the blocker"],
  [(i) => i.kindState === undefined, "sort", "label it bug:new or request:new"],
  [(i) => i.assignees.length > 0, null, ""],
  [(i) => i.kindState === "bug:new" && !i.triaged, "untriaged", "an agent triages it"],
  [(i) => i.kindState === "bug:new", "decide", "read the triage report: add bug:ready, or reply"],
  [(i) => i.kindState === "request:new", "session", "spec-session, or close it"],
  [(i) => i.kindState === "feature:spec", "session", "spec-session to finish the spec"],
  [(i) => i.kindState === "task:draft" && i.parentState === "feature:spec", null, ""],
  [
    (i) => i.kindState === "task:draft",
    "session",
    "spec-session on its feature, or set task:ready",
  ],
  [(i) => /^(bug|refactor|feature):ready$/.test(i.kindState), "run", "deliver"],
];

const PR_RULES = [
  [(p) => p.labels.includes("needs-hardware"), "run the slow lane: verify-hardware"],
  [
    (p) => p.pr.draft && p.mine && ROUTINE_BRANCH.test(p.pr.head) && p.idleDays >= STUCK_DRAFT_DAYS,
    "routine PR stuck in draft: finish or close it",
  ],
  [(p) => p.pr.draft || ADR_BRANCH.test(p.pr.head), null],
  [(p) => p.mine, "ready, not merged: merge it, or read why the gate held it"],
  [() => true, "review it"],
];

const kindState = (issue) => issue?.labels.find((l) => STATE_LABEL.test(l));

// why: an issue with a pending decision is listed for that too, so one issue can be in two
// sections.
export function inboxItems(world) {
  const now = new Date(world.now).getTime();
  const byNumber = new Map(world.issues.map((i) => [i.number, i]));
  const items = [];
  for (const raw of world.issues) {
    const parentState = kindState(byNumber.get(raw.parent));
    const issue = { ...raw, kindState: kindState(raw), parentState };
    const age = Math.floor((now - new Date(issue.createdAt).getTime()) / DAY_MS);
    const base = { number: issue.number, age, title: issue.title };
    const found = issue.pr ? prItem(issue, world.me, now) : issueItem(issue, world.runnable ?? {});
    if (found !== null) items.push({ ...base, ...found });
    const pending = issue.body.split(PENDING).length - 1;
    if (pending > 0) {
      const action = `confirm or reverse ${pending} decision${pending === 1 ? "" : "s"} delivery took`;
      items.push({ ...base, section: "decisions", label: issue.state, action });
    }
  }
  return items.sort((a, b) => b.age - a.age || a.number - b.number);
}

function prItem(issue, me, now) {
  const idleDays = (now - new Date(issue.pr.updatedAt).getTime()) / DAY_MS;
  const pr = { ...issue, mine: issue.author === me, idleDays };
  if (pr.state !== "open") return null;
  const rule = PR_RULES.find(([applies]) => applies(pr));
  if (rule[1] === null) return null;
  return { section: "prs", label: pr.mine ? "yours" : `@${pr.author}`, action: rule[1] };
}

function issueItem(issue, runnable) {
  const tasks = runnable[issue.number] ?? [];
  if (issue.state === "open" && tasks.length > 0) {
    const action = `deliver (runnable: ${tasks.map((t) => `#${t}`).join(" ")})`;
    return { section: "run", label: issue.kindState, action };
  }
  const rule = ISSUE_RULES.find(([applies]) => applies(issue));
  if (rule === undefined || rule[1] === null) return null;
  return { section: rule[1], label: issue.kindState ?? "no label", action: rule[2] };
}

// why: with no snapshot (`previous` null) nothing is marked new, or a first run would mark it all.
export function inboxReport(items, previous) {
  const keys = items.map((i) => `${i.section}#${i.number}`);
  const before = new Set(previous ?? keys);
  const gone = [...before].filter((k) => !keys.includes(k));
  const fresh = keys.filter((k) => !before.has(k));
  const changed = fresh.length + gone.length > 0;
  const lines = [
    `Inbox: ${items.length} items, ${fresh.length} new, ${gone.length} gone. Changed: ${changed ? "yes" : "no"}`,
  ];
  for (const section of SECTIONS) {
    const rows = items.filter((i) => i.section === section);
    if (rows.length === 0) continue;
    lines.push("", `## ${section}`);
    for (const i of rows) {
      const mark = fresh.includes(`${section}#${i.number}`) ? "+" : " ";
      lines.push(`${mark} #${i.number} ${i.age}d ${i.label} | ${i.action} | ${i.title}`);
    }
  }
  if (gone.length > 0) lines.push("", `Gone: ${gone.join(", ")}`);
  return { text: lines.join("\n"), keys };
}

function gh(path, fields = {}) {
  const args = Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`]);
  const out = execFileSync("gh", ["api", "-X", "GET", "--paginate", "--slurp", path, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  // why: a list endpoint answers an array per page, the search endpoint an object with `items`.
  return JSON.parse(out).flatMap((page) => page.items ?? page);
}

function fetchWorld(now) {
  const repo = `repos/${repository()}`;
  const pulls = new Map(
    gh(`${repo}/pulls`, { state: "open", per_page: 100 }).map((p) => [p.number, p]),
  );
  const open = gh(`${repo}/issues`, { state: "open", per_page: 100 });
  // why: delivery marks a decision pending in the issue body, and the issue usually closes with
  // its PR before the maintainer has confirmed it; only the search endpoint finds those.
  const q = `repo:${repository()} is:issue is:closed in:body "pending the maintainer"`;
  const closed = gh("search/issues", { q, per_page: 100 });
  const issues = [...open, ...closed].map((i) => {
    const labels = i.labels.map((l) => l.name);
    const pull = pulls.get(i.number);
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      labels,
      assignees: i.assignees.map((a) => a.login),
      author: i.user.login,
      createdAt: i.created_at,
      body: i.body ?? "",
      parent: i.parent_issue_url ? Number(i.parent_issue_url.split("/").pop()) : null,
      triaged: labels.includes("bug:new") && i.comments > 0 && hasTriageReport(repo, i.number),
      pr: pull ? { draft: pull.draft, head: pull.head.ref, updatedAt: pull.updated_at } : null,
    };
  });
  const features = issues.filter((i) => i.labels.includes("feature:planned")).map((i) => i.number);
  const me = execFileSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8" }).trim();
  return {
    now: now.toISOString(),
    me,
    issues,
    runnable: Object.fromEntries(features.map(runnable)),
  };
}

function hasTriageReport(repo, number) {
  return gh(`${repo}/issues/${number}/comments`, { per_page: 100 }).some((c) =>
    TRIAGE_REPORT.test(c.body ?? ""),
  );
}

function runnable(feature) {
  let out;
  try {
    out = execFileSync(
      "node",
      [fileURLToPath(new URL("runnable.mjs", import.meta.url)), String(feature)],
      {
        encoding: "utf8",
      },
    );
  } catch (error) {
    // why: runnable.mjs exits 1 on a bad Depends on and still prints its `runnable:` line.
    out = String(error.stdout ?? "");
  }
  const line = /^runnable: (.*)$/m.exec(out)?.[1] ?? "none";
  return [feature, [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))];
}

function defaultState() {
  const dir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  return join(dir, "inbox-state.json");
}

function main() {
  const { values: options } = parseArgs({
    options: {
      save: { type: "boolean", default: false },
      state: { type: "string" },
      input: { type: "string" },
    },
  });
  const world =
    options.input === undefined
      ? fetchWorld(new Date())
      : JSON.parse(readFileSync(options.input, "utf8"));
  const state = options.state ?? defaultState();
  const previous = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).keys : null;
  const report = inboxReport(inboxItems(world), previous);
  console.log(report.text);
  if (options.save)
    writeFileSync(state, `${JSON.stringify({ savedAt: world.now, keys: report.keys })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

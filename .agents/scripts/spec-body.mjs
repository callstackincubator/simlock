// What `spec-lint.mjs` and `runnable.mjs` share: reading a feature or task body as GitHub holds
// it, splitting it by heading, and walking the Depends on graph of a feature's tasks. Not run on
// its own.
//
// An issue is `{ number, state, labels, assignees, parent, body, subIssues, prs }`: `state` is
// `open` or `closed`, `labels` and `assignees` are names, `parent` a number or null, `subIssues`
// numbers, `prs` the open PRs that close it as `{ number, draft }`. `issues(numbers, world)`
// reads them through one GraphQL query, or from `world` (the `--world <file>` JSON, `{ "<n>":
// issue }`) without touching GitHub; a number GitHub does not know is absent from the result.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const IS_FOOTER = /^[*_]Written by an agent\.[*_]$/;

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

export function readWorld(path) {
  return path === null ? null : JSON.parse(readFileSync(path, "utf8"));
}

function nwo() {
  return (
    process.env.GH_REPO ??
    run("git", ["remote", "get-url", "origin"])
      .trim()
      .replace(/\.git$/, "")
      .replace(/.*[/:]([^/:]+\/[^/]+)$/, "$1")
  );
}

const FIELDS = `number state body
  labels(first:20){nodes{name}} assignees(first:5){nodes{login}} parent{number}
  subIssues(first:50){nodes{number}}
  closedByPullRequestsReferences(first:10, includeClosedPrs:false){nodes{number isDraft state}}`;

function fromGraphql(node) {
  return {
    number: node.number,
    state: node.state.toLowerCase(),
    body: node.body ?? "",
    labels: node.labels.nodes.map((l) => l.name),
    assignees: node.assignees.nodes.map((a) => a.login),
    parent: node.parent?.number ?? null,
    subIssues: node.subIssues.nodes.map((s) => s.number),
    prs: node.closedByPullRequestsReferences.nodes
      .filter((p) => p.state === "OPEN")
      .map((p) => ({ number: p.number, draft: p.isDraft })),
  };
}

const BLANK = {
  state: "open",
  body: "",
  labels: [],
  assignees: [],
  parent: null,
  subIssues: [],
  prs: [],
};

function normalise(n, raw) {
  return { ...BLANK, ...raw, number: n };
}

export function issues(numbers, world) {
  const wanted = [...new Set(numbers)];
  if (world !== null) return fromWorld(wanted, world);
  return wanted.length === 0 ? new Map() : fromGitHub(wanted);
}

function fromWorld(wanted, world) {
  const found = new Map();
  for (const n of wanted) if (world[n] !== undefined) found.set(n, normalise(n, world[n]));
  return found;
}

function graphql(query) {
  try {
    return run("gh", ["api", "graphql", "-f", `query=${query}`]);
  } catch (error) {
    // why: GraphQL answers a number it cannot resolve with an error beside the data, and gh then
    // exits 1 with the whole reply on stdout; the other aliases are still good.
    if (!error.stdout) throw error;
    return error.stdout;
  }
}

function fromGitHub(wanted) {
  const [owner, repo] = nwo().split("/");
  const aliases = wanted.map((n) => `i${n}: issue(number:${n}){ ${FIELDS} }`).join("\n");
  const reply = JSON.parse(
    graphql(`query{ repository(owner:"${owner}",name:"${repo}"){ ${aliases} } }`),
  );
  const data = reply.data?.repository ?? {};
  const found = new Map();
  for (const n of wanted) if (data[`i${n}`]) found.set(n, fromGraphql(data[`i${n}`]));
  return found;
}

export function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

export function splitBody(body) {
  const lines = body.replace(/\r/g, "").split("\n");
  const heads = [];
  let fence = false;
  lines.forEach((line, at) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{2,4})\s+(.*\S)\s*$/.exec(line);
    if (h !== null) heads.push({ level: h[1].length, title: h[2], at });
  });
  const sections = heads.map((h, i) => {
    const next = heads.slice(i + 1).find((o) => o.level <= h.level);
    return { ...h, lines: lines.slice(h.at + 1, next === undefined ? lines.length : next.at) };
  });
  return { lines, preamble: lines.slice(0, heads[0]?.at ?? lines.length), sections };
}

export function section(parsed, title, level) {
  return parsed.sections.find(
    (s) => s.title === title && (level === undefined || s.level === level),
  );
}

export function prose(lines) {
  let fence = false;
  return stripComments(lines.join("\n"))
    .split("\n")
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        return false;
      }
      return !fence;
    });
}

export function bullets(lines) {
  const out = [];
  for (const line of prose(lines)) {
    if (/^[-*] /.test(line)) out.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && out.length > 0 && !/^\s+[-*] /.test(line)) {
      out[out.length - 1] += ` ${line.trim()}`;
    }
  }
  return out;
}

export function cells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

export function tables(lines) {
  const out = [];
  let current = null;
  for (const line of prose(lines)) {
    if (!/^\s*\|/.test(line)) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { header: cells(line), rows: [] };
      out.push(current);
    } else if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      current.rows.push(cells(line));
    }
  }
  return out;
}

export function dependsOn(body) {
  const s = section(splitBody(body), "Depends on", 2);
  if (s === undefined) return [];
  return bullets(s.lines)
    .map((b) => /^#(\d+)\b/.exec(b))
    .filter((m) => m !== null)
    .map((m) => Number(m[1]));
}

const finding = (level, issue, text) => ({ level, issue, section: "Depends on", text });

function outsideFinding(task, dep, target, subs) {
  if (target === undefined) return finding("B", task, `#${dep} does not exist; fix the line`);
  if (subs.has(dep)) return null;
  if (target.state === "closed") {
    return finding("N", task, `#${dep} is closed, so the line orders nothing; drop it`);
  }
  const parent = target.parent === null ? "no feature" : `feature #${target.parent}`;
  return finding("N", task, `depends-outside #${dep} (open, ${parent})`);
}

function duplicateFindings(task, deps) {
  return deps
    .filter((d, i) => deps.indexOf(d) !== i)
    .map((d) => finding("N", task, `#${d} is listed twice`));
}

function longest(task, edges, memo, path) {
  if (path.includes(task)) return { cycle: [...path.slice(path.indexOf(task)), task] };
  if (memo.has(task)) return memo.get(task);
  let best = { length: 1 };
  for (const dep of edges.get(task) ?? []) {
    const sub = longest(dep, edges, memo, [...path, task]);
    if (sub.cycle) return sub;
    if (sub.length + 1 > best.length) best = { length: sub.length + 1 };
  }
  memo.set(task, best);
  return best;
}

export function graph(tasks, known) {
  const subs = new Set(tasks.map((t) => t.number));
  const edges = new Map();
  const findings = [];
  for (const task of tasks) {
    const deps = dependsOn(task.body);
    edges.set(
      task.number,
      [...new Set(deps)].filter((d) => subs.has(d)),
    );
    if (task.state !== "open") continue;
    findings.push(...duplicateFindings(task.number, deps));
    for (const dep of new Set(deps)) {
      const f = outsideFinding(task.number, dep, known.get(dep), subs);
      if (f !== null) findings.push(f);
    }
  }
  const memo = new Map();
  let chain = 0;
  for (const task of tasks) {
    const result = longest(task.number, edges, memo, []);
    if (result.cycle) {
      const loop = result.cycle.map((n) => `#${n}`).join(" → ");
      findings.push(finding("B", task.number, `a cycle: ${loop}; drop one of its lines`));
      return { findings, chain: null, cycle: result.cycle, edges };
    }
    chain = Math.max(chain, result.length);
  }
  return { findings, chain, cycle: null, edges };
}

export function printFinding(f) {
  console.log(`${f.level} ${f.issue ?? "-"} ${f.section}: ${f.text}`);
}

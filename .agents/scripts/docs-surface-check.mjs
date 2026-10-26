#!/usr/bin/env node
// `node .agents/scripts/docs-surface-check.mjs [--base <ref>] [--head <ref>]`: the mechanical
// half of documentation rule 9. Since <head> (default HEAD) left <base> (default origin/main),
// a change to the public surface goes with a change to a page under website/src/content/docs/:
// one without the other prints the surfaces it changed and the exit code is 1. The surface is:
//
//   cli        src/cli/tree.ts, the command tree
//   config     src/core/config.ts, the config type, defaults and validator
//   errors     the ERROR_TABLE object in src/contract/errors.ts
//   mcp        each `registerTool(` name and definition object in src/mcp/server.ts, and the
//              tool schemas in src/mcp/contracts.ts
//   http       each `declareRoute(...)` call in src/http/*.ts
//   client     src/client/index.ts and src/admin/index.ts, the package's two exports
//   events     the EventMap interface in src/bus/index.ts, which EventName is the keys of
//
// A part counts as changed when its code differs once comments and whitespace are dropped, so
// a comment or a reflow is no change. A commit in the range with the trailer `Docs: none
// (<reason>)` lets a surface change through (a refactor, an internal rename); whether the
// reason holds is the review's question.
import { execFileSync } from "node:child_process";

import { option } from "./cli-args.mjs";

const TRAILER = /^Docs: none \(.+\)\s*$/m;
const DOCS = "website/src/content/docs/";
const QUOTES = ["'", '"', "`"];

const git = (...a) =>
  execFileSync("git", a, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const head = option("--head") ?? "HEAD";
const base = git("merge-base", option("--base") ?? "origin/main", head).trim();

const whole = (text) => [text];
const calls = (pattern) => (text) =>
  [...text.matchAll(pattern)].map((m) => balanced(text, m.index + m[0].length - 1));
const block = (pattern) => (text) => {
  const m = pattern.exec(text);
  return m === null ? [] : [balanced(text, m.index + m[0].length - 1)];
};
const tools = (text) =>
  [...text.matchAll(/registerTool\(\s*("[^"]*")/g)].map((m) => {
    const open = text.indexOf("{", m.index + m[0].length);
    return `${m[1]} ${balanced(text, open)}`;
  });

const SURFACES = [
  { name: "cli", files: ["src/cli/tree.ts"], parts: whole },
  { name: "config", files: ["src/core/config.ts"], parts: whole },
  {
    name: "errors",
    files: ["src/contract/errors.ts"],
    parts: block(/export const ERROR_TABLE\b[^=]*=\s*\{/),
  },
  { name: "mcp", files: ["src/mcp/server.ts"], parts: tools },
  { name: "mcp", files: ["src/mcp/contracts.ts"], parts: whole },
  { name: "http", files: httpFiles(), parts: calls(/declareRoute\(/g) },
  { name: "client", files: ["src/client/index.ts", "src/admin/index.ts"], parts: whole },
  { name: "events", files: ["src/bus/index.ts"], parts: block(/export interface EventMap \{/) },
];

const changed = [...new Set(SURFACES.filter(changes).map((s) => s.name))];
const documented = git("diff", "--name-only", base, head, "--", DOCS).trim() !== "";
const waived = TRAILER.test(git("log", "--format=%B", `${base}..${head}`));
if (changed.length > 0 && !documented && !waived) {
  console.log(
    `The public surface changed (${changed.join(", ")}), but no page under ${DOCS} did. ` +
      `Update the pages that describe it (documentation rule 9), or add the trailer "Docs: none (<reason>)" to a commit.`,
  );
  process.exit(1);
}

function httpFiles() {
  return [base, head]
    .flatMap((rev) => git("ls-tree", "--name-only", `${rev}:src/http/`).split("\n"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => `src/http/${f}`)
    .filter((f, i, all) => all.indexOf(f) === i);
}

function show(rev, file) {
  try {
    return git("show", `${rev}:${file}`);
  } catch {
    return "";
  }
}

// why: a string or a comment may hold an unmatched bracket; the scan skips both, so a call
// or a block ends at its own closing bracket.
function balanced(text, open) {
  const pair = { "(": ")", "{": "}", "[": "]" };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const skip = skipped(text, i);
    if (skip > i) {
      i = skip - 1;
    } else if (pair[text[i]] !== undefined) {
      stack.push(pair[text[i]]);
    } else if (text[i] === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

function skipped(text, i) {
  const two = text.slice(i, i + 2);
  if (two === "//") return endOf(text, "\n", i);
  if (two === "/*") return endOf(text, "*/", i);
  const quote = text[i];
  if (!QUOTES.includes(quote)) return i;
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

function endOf(text, marker, from) {
  const at = text.indexOf(marker, from + 2);
  return at === -1 ? text.length : at + marker.length;
}

function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/\s+/g, "");
}

function changes(surface) {
  return surface.files.some((file) => {
    const before = surface.parts(show(base, file)).map(code);
    const after = surface.parts(show(head, file)).map(code);
    return before.join("\n") !== after.join("\n");
  });
}

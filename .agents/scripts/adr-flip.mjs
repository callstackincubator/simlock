#!/usr/bin/env node
// `node .agents/scripts/adr-flip.mjs <nnnn> [<nnnn> ...] --branch <branch>`: flips each ADR from
// _Accepted — not yet implemented_ to _Accepted_ on <branch> (delivery rule 10), so no fix run
// is spent on it. In a temporary detached worktree of origin/<branch> it drops "— not yet
// implemented" from the ADR's Status item and from its row of docs/internal/adr/README.md,
// commits `docs(adr): <nnnn> to Accepted (#<n>)` (<n> from a `<kind>/<n>` branch), runs
// adr-flip-check.mjs on the commit and pushes it as a fast-forward of the branch.
//
// Exit 0: `adr-flip: pushed <full sha> <nnnn> ...`, or `adr-flip: current` when every ADR
// already reads Accepted. Exit 1, nothing pushed, one `adr-flip: ...` line each: an ADR with no
// file on the branch or another Status, what adr-flip-check.mjs says, a push git refused.
// Usage errors exit 64.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { option } from "./cli-args.mjs";

const args = process.argv.slice(2);
const branch = option("--branch");
const at = args.indexOf("--branch");
const numbers = args.filter((_, i) => i !== at && i !== at + 1);
if (branch === null || numbers.length === 0 || numbers.some((n) => !/^\d{4}$/.test(n))) {
  console.error("usage: adr-flip.mjs <nnnn> [<nnnn> ...] --branch <branch>");
  process.exit(64);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const ADRS = "docs/internal/adr";
const PENDING = /Accepted\s+(?:—|–|-)\s+not\s+yet\s+implemented/;
const git = (cwd, ...argv) =>
  execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  git(".", "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
} catch {
  console.log(`adr-flip: cannot fetch origin/${branch}`);
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), "adr-flip-"));
const tree = join(scratch, "tree");
git(".", "worktree", "add", "-q", "--detach", tree, `origin/${branch}`);
let outcome;
try {
  const edited = edit();
  if (edited.problems.length > 0) outcome = edited;
  else if (edited.flipped.length === 0) outcome = { problems: [], done: "current" };
  else outcome = publish(edited.flipped);
} finally {
  spawnSync("git", ["worktree", "remove", "--force", tree]);
  rmSync(scratch, { recursive: true, force: true });
}
for (const problem of outcome.problems) console.log(`adr-flip: ${problem}`);
if (outcome.problems.length > 0) process.exit(1);
console.log(`adr-flip: ${outcome.done}`);

function edit() {
  const problems = [];
  const flipped = [];
  const index = join(tree, ADRS, "README.md");
  let rows = existsSync(index) ? readFileSync(index, "utf8").split("\n") : [];
  const files = existsSync(join(tree, ADRS)) ? readdirSync(join(tree, ADRS)) : [];
  for (const number of numbers) {
    const name = files.find((f) => new RegExp(`^${number}-.*\\.md$`).test(f));
    const problem =
      name === undefined ? `${number}: no ${ADRS}/${number}-*.md on ${branch}` : status(name);
    if (problem === "pending") {
      rows = rows.map((r) => (r.startsWith(`| [${number}](`) ? r.replace(PENDING, "Accepted") : r));
      flipped.push(number);
    } else if (problem !== null) {
      problems.push(problem);
    }
  }
  if (rows.length > 0) writeFileSync(index, rows.join("\n"));
  return { problems, flipped };
}

// why: "pending" after rewriting the file, null for an ADR already Accepted, else what is wrong.
function status(name) {
  const lines = readFileSync(join(tree, ADRS, name), "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith("- **Status:**"));
  const after = lines.findIndex((l, i) => i > from && !/^\s+\S/.test(l));
  const item = from === -1 ? [] : lines.slice(from, after === -1 ? lines.length : after);
  if (PENDING.test(item.join("\n"))) {
    lines.splice(from, item.length, item.join("\n").replace(PENDING, "Accepted"));
    writeFileSync(join(tree, ADRS, name), lines.join("\n"));
    return "pending";
  }
  if (/^- \*\*Status:\*\* Accepted\b/.test(item[0] ?? "")) return null;
  return `${ADRS}/${name}: its Status is not "Accepted — not yet implemented": "${(item[0] ?? "no Status item").trim().slice(0, 60)}"`;
}

function publish(flipped) {
  // why: the push hook checks the whole tree, which needs the worktree's dependencies.
  const hooks = join(git(".", "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
  if (existsSync(join(hooks, "pre-push"))) {
    spawnSync(join(HERE, "worktree.sh"), ["--prepare", tree], { stdio: "ignore" });
  }
  const issue = /^(?:bug|task|feature|refactor)\/(\d+)/.exec(branch)?.[1];
  const closes = issue === undefined ? "" : ` (#${issue})`;
  git(tree, "add", ADRS);
  git(tree, "commit", "-q", "-m", `docs(adr): ${flipped.join(", ")} to Accepted${closes}`);
  const check = spawnSync(process.execPath, [join(HERE, "adr-flip-check.mjs"), "HEAD"], {
    cwd: tree,
    encoding: "utf8",
  });
  if (check.status !== 0) {
    const said = check.stdout.split("\n").filter((l) => l !== "");
    return { problems: said.map((l) => l.replace(/^adr-flip: /, "")) };
  }
  const push = spawnSync("git", ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], {
    cwd: tree,
    encoding: "utf8",
  });
  if (push.status !== 0) {
    const last = push.stderr.trim().split("\n").at(-1);
    return { problems: [`git refused the push to ${branch}: ${last}`] };
  }
  return { problems: [], done: `pushed ${git(tree, "rev-parse", "HEAD")} ${flipped.join(" ")}` };
}

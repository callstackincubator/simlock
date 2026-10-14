#!/usr/bin/env node
// PreToolUse hook (Bash, Agent): refuses three kinds of tool call the delivery rules forbid.
//
//   check      a sub-agent runs a check from toolchain.md's "Checks agents never run" (`pnpm
//              check`, `pnpm fallow`, ...) or a tool behind one, from any path. The commit hook,
//              the push hook and CI run them. The main session (a person, a routine) may.
//   hooks      a sub-agent skips the git hooks: `--no-verify`, `LEFTHOOK=0`, `core.hooksPath`, or
//              `LEFTHOOK_EXCLUDE` naming anything but `fallow` (the red stage's one push, whose
//              placeholders Fallow calls dead code).
//   isolation  an `implementer`, `reviewer` or `hardware-verifier` is started with `isolation`.
//              Every stage of a task works in the task's one worktree, one after another.
//
// A refusal exits 2 with the reason on stderr, which the agent reads.
import fs from "node:fs";
import path from "node:path";

const SCRIPTS = new Set([
  "check",
  "test",
  "typecheck",
  "typecheck:e2e",
  "lint",
  "lint:comments",
  "format",
  "format:check",
  "fallow",
  "mutate",
]);
const TOOLS = new Set(["tsc", "oxlint", "depcruise", "oxfmt", "fallow", "stryker"]);
const NODE_SCRIPTS = new Set(["comment-lint.mjs", "mutate.mjs"]);
const WRAPPERS = new Set(["time", "nice", "env", "command", "exec"]);
const PNPM_VALUE_FLAGS = new Set(["-C", "--dir", "-F", "--filter", "--reporter"]);
const STAGES = new Set(["implementer", "reviewer", "hardware-verifier"]);
const HOOK_BYPASS = [
  /--no-verify\b/,
  /\bLEFTHOOK=(?:0|false)\b/,
  /\bcore\.hooksPath\b/,
  /\bLEFTHOOK_EXCLUDE=(?!fallow(?:\s|$))/,
];

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const tool = input.tool_name;
const args = input.tool_input ?? {};

if ((tool === "Agent" || tool === "Task") && args.isolation && STAGES.has(args.subagent_type)) {
  refuse(
    `Refused: pass no \`isolation\` to the ${args.subagent_type}. Every stage of a task works in ` +
      "the task's one worktree (`.agents/scripts/worktree.sh <branch>`), one stage after " +
      "another. Start the agent again without `isolation`.",
  );
}

if (tool === "Bash" && typeof input.agent_id === "string") {
  const shell = code(args.command ?? "");
  if (HOOK_BYPASS.some((re) => re.test(shell))) {
    refuse(
      "Refused: this skips the git hooks. They run the checks agents never run by hand. Only the " +
        "red stage may skip Fallow, on its one push: `LEFTHOOK_EXCLUDE=fallow git push ...`.",
    );
  }
  const found = forbiddenCheck(shell);
  if (found !== null) {
    refuse(
      `Refused: \`${found}\` is under "Checks agents never run" in toolchain.md. The commit ` +
        "hook runs lint, the comment lint and typecheck; the push hook runs Fallow and the e2e " +
        "typecheck; CI runs the rest. Their errors show in the commit or push output. Run only " +
        'the commands under "Tests agents run".',
    );
  }
}
process.exit(0);

function refuse(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function code(command) {
  // why: a heredoc body is data (a script fed to python or cat), not commands the shell runs.
  // why: so is a quoted string (a commit message, a PR title, a sed script).
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, "$3")
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

function forbiddenCheck(shell) {
  for (const segment of shell.split(/\|\||&&|[;|&\n()`]|\$\(/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
    while (words.length > 0 && (/^\w+=/.test(words[0]) || WRAPPERS.has(words[0]))) words.shift();
    if (words[0] === "timeout") words.splice(0, 2);
    if (words.length > 0 && isForbidden(words)) return segment.trim().replace(/\s*\d?>+$/, "");
  }
  return null;
}

function isForbidden(words) {
  const [first, ...rest] = words;
  const name = path.basename(first);
  if (TOOLS.has(name) || NODE_SCRIPTS.has(name)) return true;
  if (name === "node") return rest.some((w) => NODE_SCRIPTS.has(path.basename(w)));
  if (name === "npx" || name === "bunx") return isTool(firstOperand(rest));
  return name === "pnpm" && isForbiddenPnpm(rest);
}

function isForbiddenPnpm(args) {
  const operands = pnpmOperands(args);
  const [sub, ...after] = operands[0] === "run" ? operands.slice(1) : operands;
  if (sub === "exec" || sub === "dlx") return isTool(after[0]);
  // why: pnpm runs a binary it does not know as a script, so `pnpm tsc` is `pnpm exec tsc`.
  if (isTool(sub)) return true;
  // why: these scripts are allowed only in their narrow forms: named e2e files, Chromium only.
  if (sub === "test:e2e") return after.length === 0;
  if (sub === "test:console") return !args.includes("--project=chromium");
  return SCRIPTS.has(sub);
}

function pnpmOperands(args) {
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    if (PNPM_VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith("-")) operands.push(args[i]);
  }
  return operands;
}

function isTool(word) {
  return TOOLS.has(path.basename(word ?? ""));
}

function firstOperand(words) {
  return words.find((w) => !w.startsWith("-"));
}

function unquote(word) {
  return word.replace(/^['"]|['"]$/g, "");
}

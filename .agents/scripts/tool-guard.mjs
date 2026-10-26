#!/usr/bin/env node
// PreToolUse hook (Bash, Agent): refuses three kinds of tool call the delivery rules forbid.
//
//   check      a sub-agent runs a check from toolchain.md's "Checks agents never run" (`pnpm
//              check`, `pnpm fallow`, ...) or a tool behind one, from any path. The commit hook,
//              the push hook and CI run them. The main session (a person, a routine) may.
//   hooks      a sub-agent skips the git hooks: `--no-verify`, `LEFTHOOK=0`, `core.hooksPath`, or
//              `LEFTHOOK_EXCLUDE` naming anything but `fallow` (a build stage's push before its
//              last cycle, whose code a later cycle wires in Fallow calls dead code).
//   isolation  an `implementer`, `reviewer` or `hardware-verifier` is started with `isolation`.
//              Every stage of a task works in the task's one worktree, one after another.
//   waiting    a sub-agent runs a test runner without `timeout: 600000` on the Bash call (the
//              default 120 s moves a two-minute run to the background), starts a background job
//              (`run_in_background`, a trailing `&`), polls in a loop that sleeps, or runs a bare
//              `cat > file` with no input (it reads stdin until the tool times out). Each of
//              these turned into a stall: a backgrounded job holds the agent's report until the
//              job ends or hits its 30-minute cap. The slow lane is exempt: `slow-e2e.sh` runs
//              detached by design and its agents wait on `<log>.exit` (delivery rule 16).
//
//   prompt     a stage or lens agent (`implementer`, `reviewer`, `hardware-verifier`,
//              `spec-reviewer`, `code-reviewer`, `claims-reviewer`) is started without the ledger
//              tag as its prompt's first line (toolchain.md, "Review measurement"); an
//              `implementer` without `brief:` and its mode's brief text, a `reviewer` without
//              `protocol:` and REVIEW.md's text; a stage agent with a `model`; a `code-reviewer`
//              off Opus on a diff that touches a strict area (REVIEW.md, "Routing"), outside a
//              replay; or a sub-agent starts a helper that is not `run_in_background: false`.
//   git        a sub-agent runs `git stash`, `git rebase` (or `pull --rebase`), or a push that
//              rewrites or deletes a remote branch (`+<ref>`, `:<ref>`, `--force`, `--delete`).
//   gh         a sub-agent opens a PR without `--draft` (or a REST create without
//              `draft=true`), opens one from a `-repro` branch, runs `gh pr ready`, or adds
//              `bug:ready`, `task:ready` or `feature:planned`; any session assigns an issue by
//              hand instead of through `claim.mjs`.
//   body       any session posts a body or comment (`gh issue|pr comment|create|edit|close`,
//              `gh api ... body=`) that `body-rules.mjs` rejects, or one the guard cannot read
//              (built by `$(...)`, a backtick or a variable: use `--body-file`).
//   slow lane  any session runs vitest on an `e2e/slow-*` file, or the e2e project without a
//              `!slow` tags filter; a sub-agent runs `pnpm test:e2e:slow` (or a physical lane);
//              an agent other than `hardware-verifier` and `implementer` runs `slow-e2e.sh`
//              for anything but `status` (delivery rule 16).
//
// A refusal exits 2 with the reason on stderr, which the agent reads.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bodyDefects } from "./body-rules.mjs";
import { commandWords, parseShell } from "./shell-words.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCRIPTS = new Set([
  "check",
  "test",
  "test:timing",
  "typecheck",
  "typecheck:e2e",
  "typecheck:e2e:types",
  "lint",
  "lint:comments",
  "lint:tests",
  "format",
  "format:check",
  "fallow",
  "mutate",
]);
const TOOLS = new Set(["tsc", "oxlint", "depcruise", "oxfmt", "fallow", "stryker"]);
const NODE_SCRIPTS = new Set(["comment-lint.mjs", "test-lint.mjs", "mutate.mjs"]);
const WRAPPERS = new Set(["time", "nice", "env", "command", "exec"]);
const PNPM_VALUE_FLAGS = new Set(["-C", "--dir", "-F", "--filter", "--reporter"]);
const STAGES = new Set(["implementer", "reviewer", "hardware-verifier"]);
const LENSES = new Set(["spec-reviewer", "code-reviewer", "claims-reviewer"]);
const LEDGER =
  /^ledger: (?=.*\bpr=\S+)(?=.*\bstage=(?:build|audit|fix|hardware-fix|review|hardware|replay)\b)(?=.*\brole=\S+)/;
// why: toolchain.md "Project checks" lists these; src/contract/ holds the wire validators.
const STRICT_AREAS = [
  /^src\/leasing\//,
  /^src\/contract\//,
  /^src\/core\/cleanup\//,
  /^src\/core\/(?:registry|serialized-decision|device-operation-claims|reclaim-coordinator|quarantine-coordinator|reaper|cleanup-executor|nuke|nuke-service|managed-device-lifecycle|device-root|physical-enrollment|startup-converger)\.ts$/,
];
const WORK_LABELS = new Set(["bug:ready", "task:ready", "feature:planned"]);
const SLOW_LANE_AGENTS = new Set(["hardware-verifier", "implementer"]);
const SLOW_LANE_SCRIPTS = new Set([
  "test:e2e:slow",
  "test:e2e:physical",
  "test:e2e:physical-manual",
]);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);
// why: the runners agents are allowed to run; `slow-e2e.sh` is excluded above, not here.
const TEST_RUNNER =
  /\bvitest\s+(?:run|--)|\bplaywright\s+test\b|\bpnpm\s+(?:run\s+)?test(?::[\w-]+)?(?:\s|$)/;
// why: a `&` that is not `&&` and ends a command or a line starts a background job.
const BACKGROUND_JOB = /(?:^|[^&])&\s*(?:$|\n|\)|;)/m;
const SLEEP_LOOP = /\b(?:until|while|for)\b[^\n]*\bdo\b[\s\S]*?\bsleep\b/;
// why: `cat > file` followed by a terminator, with no `<<` heredoc and no `<` input, hangs.
const BARE_CAT = /(?:^|[;&|]\s*|\n\s*)cat\s*>{1,2}\s*\S+(?:\s+\d?>{1,2}\S+)*\s*(?:;|&&|\|\||\n|$)/;
const HOOK_BYPASS = [
  /--no-verify\b/,
  /\bLEFTHOOK=(?:0|false)\b/,
  /\bcore\.hooksPath\b/,
  /\bLEFTHOOK_EXCLUDE=(?!fallow(?:\s|$))/,
];

// why: each rule is a refusal and the test that triggers it; `refuseFirst` walks a table.
function refuseFirst(rules, ctx) {
  for (const rule of rules) {
    if (rule.when(ctx)) refuse(typeof rule.reason === "function" ? rule.reason(ctx) : rule.reason);
  }
}

const AGENT_RULES = [
  {
    when: (c) => Boolean(args.isolation) && STAGES.has(c.type),
    reason: (c) =>
      `Refused: pass no \`isolation\` to the ${c.type}. Every stage of a task works in ` +
      "the task's one worktree (`.agents/scripts/worktree.sh <branch>`), one stage after " +
      "another. Start the agent again without `isolation`.",
  },
  {
    when: (c) => STAGES.has(c.type) && typeof args.model === "string" && args.model !== "",
    reason: (c) =>
      `Refused: pass no \`model\` to the ${c.type}: it runs on the model its frontmatter pins. ` +
      "Start the agent again without `model`.",
  },
  {
    when: () => subAgent && args.run_in_background !== false,
    reason:
      "Refused: a helper agent runs in the foreground: pass `run_in_background: false`. A " +
      "background helper reports to the orchestrator, not to you, and nothing wakes you when " +
      "it ends.",
  },
  {
    when: (c) => (STAGES.has(c.type) || LENSES.has(c.type)) && !LEDGER.test(firstLine(c.prompt)),
    reason:
      "Refused: the prompt's first line is the ledger tag (toolchain.md, \"Review " +
      'measurement"): `ledger: pr=<M> issue=<N> stage=<stage> round=<r> role=<role> ' +
      "lens=<lens>`, `-` for a key that does not apply yet. Start the agent again with it.",
  },
];
const PROMPT_CHECKS = {
  implementer: briefCheck,
  reviewer: protocolCheck,
  "code-reviewer": strictAreaCheck,
};

function agentRules() {
  const ctx = { type: args.subagent_type, prompt: String(args.prompt ?? "") };
  refuseFirst(AGENT_RULES, ctx);
  PROMPT_CHECKS[ctx.type]?.(ctx.prompt);
}

function firstLine(prompt) {
  return prompt.replace(/^\s+/, "").split("\n")[0];
}

function briefCheck(prompt) {
  const mode = /^mode:\s*`?([\w-]+)/m.exec(prompt)?.[1];
  const file = path.join(ROOT, ".agents", "briefs", `implement-${mode}.md`);
  if (mode === undefined || !fs.existsSync(file)) {
    refuse(
      "Refused: an implementer's prompt names its mode on a `mode:` line: build, audit, fix or " +
        "hardware-fix. Start the agent again with it.",
    );
  }
  const at = prompt.search(/^brief:/m);
  const want = squash(fs.readFileSync(file, "utf8")).slice(0, 200);
  if (at === -1 || !squash(prompt.slice(at)).includes(want)) {
    refuse(
      `Refused: an implementer's prompt carries \`brief:\` and then the full text of ` +
        `\`.agents/briefs/implement-${mode}.md\` from this checkout, so the agent opens no file ` +
        "to learn its mode. Paste it and start the agent again.",
    );
  }
}

function protocolCheck(prompt) {
  const heading =
    fs
      .readFileSync(path.join(ROOT, "docs", "internal", "REVIEW.md"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("# ")) ?? "";
  const at = prompt.search(/^protocol:/m);
  const lines = at === -1 ? [] : prompt.slice(at).split("\n");
  if (!lines.some((l) => l.trim() === heading.trim())) {
    refuse(
      "Refused: a reviewer's prompt carries `protocol:` and then the full text of " +
        "`docs/internal/REVIEW.md` from this checkout. Paste it and start the agent again.",
    );
  }
}

function strictAreaCheck(prompt) {
  const model = typeof args.model === "string" ? args.model : "";
  if (model === "" || /opus/i.test(model) || /\bstage=replay\b/.test(prompt)) return;
  const hit = [...inputsPatch(prompt).matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)]
    .flatMap((m) => [m[1], m[2]])
    .find((p) => STRICT_AREAS.some((re) => re.test(p)));
  if (hit !== undefined) {
    refuse(
      `Refused: the diff touches a strict area (\`${hit}\`, toolchain.md "Project checks"), and ` +
        'its code review runs on Opus (REVIEW.md, "Routing"). Start the code-reviewer again ' +
        "with no `model`, or `model: opus`.",
    );
  }
}

// why: an `inputs:` directory the guard cannot read leaves the call alone.
function inputsPatch(prompt) {
  const dir = /^inputs:\s*[`'"]?([^`'"\s]+)/m.exec(prompt)?.[1];
  if (dir === undefined) return "";
  try {
    return fs.readFileSync(path.resolve(cwd, dir, "diff.patch"), "utf8");
  } catch {
    return "";
  }
}

function commandRules(raw) {
  const state = { dir: cwd, written: new Map() };
  for (const cmd of parseShell(raw)) {
    const { words, dynamic } = commandWords(cmd);
    if (words.length > 0 && !changesDirectory(state, words, dynamic))
      commandStep(state, cmd, words, dynamic);
  }
}

function changesDirectory(state, words, dynamic) {
  if (path.basename(words[0]) !== "cd" || words[1] === undefined || dynamic[1]) return false;
  state.dir = path.resolve(state.dir, words[1].replace(/^~(?=\/|$)/, os.homedir()));
  return true;
}

function commandStep(state, cmd, words, dynamic) {
  const name = path.basename(words[0]);
  if (name === "cat" && cmd.stdin !== null) trackWrites(state, cmd);
  if (name === "git" && subAgent) gitRules(words);
  if (name === "gh") ghRules({ words, dynamic, cmd, ...state, group: words[1], verb: words[2] });
  slowLaneRules(words);
}

// why: a body file written by a heredoc earlier in the same command is not on disk yet.
function trackWrites(state, cmd) {
  for (const r of cmd.redirects) {
    if (r.op === ">" || r.op === ">>")
      state.written.set(path.resolve(state.dir, r.target), cmd.stdin);
  }
}

const GIT_RULES = [
  {
    when: (g) => g.sub === "stash",
    reason:
      "Refused: never `git stash` in a delivery stage: every worktree shares one stash list, so " +
      "a pop can take another agent's changes. Commit the work instead.",
  },
  {
    when: (g) =>
      g.sub === "rebase" ||
      (g.sub === "pull" && g.rest.some((w) => /^(?:-r|--rebase(?!=false))/.test(w))),
    reason:
      "Refused: never rebase in a delivery stage: a stack moves by merging forward " +
      "(`.agents/scripts/stack-sync.sh`), and a rebased branch needs a force push nobody may " +
      "make (delivery rule 15). Merge the base branch instead: `git merge origin/<base>`.",
  },
  {
    when: (g) => g.sub === "push" && g.rest.some(rewritesRemote),
    reason:
      "Refused: this push rewrites or deletes a remote branch (`+<ref>`, `:<ref>`, `--force` or " +
      "`--delete`). Push fast-forwards only; when the push is rejected, merge the remote " +
      "branch in and push again.",
  },
];

function gitRules(words) {
  let at = 1;
  while (at < words.length && words[at].startsWith("-"))
    at += GIT_VALUE_FLAGS.has(words[at]) ? 2 : 1;
  refuseFirst(GIT_RULES, { sub: words[at], rest: words.slice(at + 1) });
}

function rewritesRemote(word) {
  return (
    word.startsWith("+") ||
    /^:./.test(word) ||
    /^--(?:force|delete|mirror)/.test(word) ||
    /^-[a-zA-Z]*[fd]/.test(word)
  );
}

const GH_RULES = [
  {
    when: (c) =>
      c.group === "issue" &&
      c.verb === "edit" &&
      flagValues(c.words, ["--add-assignee"]).length > 0,
    reason:
      "Refused: claim an issue with `node .agents/scripts/claim.mjs <n>` (`--triage` for a " +
      "`bug:new` triage), not by hand. It assigns you only when the issue is open, unassigned " +
      "and labelled as work an agent may take (delivery rules 1 and 2).",
  },
  {
    when: (c) => subAgent && workLabel(c) !== undefined,
    reason: (c) =>
      `Refused: agents never label their way into work (delivery rule 1): \`${workLabel(c)}\` is the ` +
      "maintainer's or the spec session's to set. Leave the label as it is and say in your " +
      "report what should change.",
  },
  {
    when: (c) => subAgent && c.group === "pr" && c.verb === "ready",
    reason:
      "Refused: only the orchestrator marks a PR ready, after its review (delivery rule 14). " +
      "Leave it in draft and report.",
  },
  {
    when: (c) => subAgent && prCreate(c) && !c.words.includes("--draft") && !c.words.includes("-d"),
    reason:
      "Refused: every PR starts in draft (delivery rule 14). Run `gh pr create` again with " +
      "`--draft`; the orchestrator marks it ready after review.",
  },
  {
    when: (c) => subAgent && prCreate(c) && prHead(c).endsWith("-repro"),
    reason:
      "Refused: a `bug/<n>-repro` branch opens no pull request (delivery rule 8). Push the " +
      "test to the branch and name it in the triage report.",
  },
  {
    when: (c) => subAgent && restCreatesReadyPr(c.words),
    reason:
      "Refused: every PR starts in draft (delivery rule 14). Create it again with " +
      "`-F draft=true`; the orchestrator marks it ready after review.",
  },
];

function ghRules(c) {
  refuseFirst(GH_RULES, c);
  const body = postedBody(c);
  const defects = body === null ? [] : bodyDefects(body);
  if (defects.length > 0) {
    const reason = defects.join(" ");
    refuse(`Refused: ${reason[0].toLowerCase()}${reason.slice(1)} Fix the body and post again.`);
  }
}

function workLabel(c) {
  return addedLabels(c.words, c.group, c.verb).find((l) => WORK_LABELS.has(l));
}

function prCreate(c) {
  return c.group === "pr" && c.verb === "create";
}

function prHead(c) {
  return flagValues(c.words, ["--head", "-H"]).at(-1) ?? currentBranch(c.dir);
}

function restCreatesReadyPr(words) {
  if (words[1] !== "api" || !/(?:^|\/)repos\/[^/]+\/[^/]+\/pulls$/.test(apiPath(words)))
    return false;
  const fields = apiFields(words);
  const method = flagValues(words, ["-X", "--method"]).at(-1)?.toUpperCase();
  const post = (method ?? (fields.length > 0 ? "POST" : "GET")) === "POST";
  return post && !fields.some((f) => f.key === "draft" && f.value === "true");
}

const BODY_VERBS = ["comment", "create", "edit", "close"];
const FIELD_FLAGS = ["-f", "-F", "--field", "--raw-field"];

// why: a body is null when the command posts none; an unreadable one refuses here.
function postedBody(c) {
  if ((c.group === "issue" || c.group === "pr") && BODY_VERBS.includes(c.verb)) return issueBody(c);
  if (c.group === "api") return apiBody(c);
  return null;
}

function issueBody(c) {
  const inline = c.verb === "close" ? ["--comment", "-c"] : ["--body", "-b"];
  const files = c.verb === "close" ? [] : ["--body-file", "-F"];
  for (let i = 3; i < c.words.length; i++) {
    const [flag, value, valueAt] = splitFlag(c.words, i);
    if (inline.includes(flag)) return readable(c, valueAt, value ?? "");
    if (files.includes(flag)) return bodyFile(c, readable(c, valueAt, value ?? ""));
  }
  return null;
}

function apiBody(c) {
  for (let i = 2; i < c.words.length; i++) {
    const [flag, value, valueAt] = splitFlag(c.words, i);
    const input =
      flag === "--input" && value !== undefined ? inputBody(c, value, valueAt) : undefined;
    if (input !== undefined) return input;
    if (FIELD_FLAGS.includes(flag) && (value ?? "").startsWith("body="))
      return fieldBody(c, flag, value, valueAt);
  }
  return null;
}

// why: undefined goes on to the next word, null stops at a file that holds no JSON.
function inputBody(c, value, valueAt) {
  try {
    const json = JSON.parse(bodyFile(c, readable(c, valueAt, value)));
    return typeof json?.body === "string" ? json.body : undefined;
  } catch {
    return null;
  }
}

function fieldBody(c, flag, value, valueAt) {
  const text = readable(c, valueAt, value).slice("body=".length);
  const file = (flag === "-F" || flag === "--field") && text.startsWith("@");
  return file ? bodyFile(c, text.slice(1)) : text;
}

function readable(c, valueAt, value) {
  if (c.dynamic[valueAt]) unreadable();
  return value;
}

function unreadable() {
  refuse(
    "Refused: the guard cannot read a body built by `$(...)`, a backtick or a variable, so it " +
      "cannot check its shape (delivery rule 12). Write the body to a file and pass " +
      "`--body-file <file>` (`-F body=@<file>` for `gh api`).",
  );
}

function bodyFile(c, file) {
  if (file === "-") {
    if (c.cmd.stdin === null || c.cmd.stdinDynamic) unreadable();
    return c.cmd.stdin;
  }
  const at = path.resolve(c.dir, file.replace(/^~(?=\/|$)/, os.homedir()));
  if (c.written.has(at)) return c.written.get(at);
  try {
    return fs.readFileSync(at, "utf8");
  } catch {
    return refuse(
      `Refused: \`${file}\` does not exist yet, so the guard cannot check the body. Write the ` +
        "file first, then post it in its own command.",
    );
  }
}

const SLOW_LANE_RULES = [
  {
    when: (words) => vitestRunsSlowLane(words),
    reason:
      "Refused: the slow lane runs only through `scripts/slow-e2e.sh <test files>`, which holds " +
      "the machine-wide lock (delivery rule 16). Run the fast e2e lane with `pnpm test:e2e " +
      "<files>`, and leave the slow lane to the hardware verifier.",
  },
  {
    when: (words) =>
      subAgent &&
      path.basename(words[0]) === "pnpm" &&
      SLOW_LANE_SCRIPTS.has(pnpmOperands(words.slice(1)).find((w) => w !== "run")),
    reason:
      "Refused: the slow lane runs only through `scripts/slow-e2e.sh <test files>`, which holds " +
      "the machine-wide lock (delivery rule 16). Run it through the script, or report the " +
      "lines that need it under `hardware`.",
  },
  {
    when: (words) => startsSlowLane(words) && !SLOW_LANE_AGENTS.has(input.agent_type ?? ""),
    reason:
      "Refused: only the hardware verifier and the implementer run the slow lane (delivery rule " +
      "16); `scripts/slow-e2e.sh status` is open to every agent. Report what needs the lane " +
      "instead.",
  },
];

function slowLaneRules(words) {
  refuseFirst(SLOW_LANE_RULES, words);
}

function vitestRunsSlowLane(words) {
  const runner = words.findIndex((w) => path.basename(w) === "vitest");
  if (runner === -1 || !runsAsCommand(words, runner)) return false;
  const after = words.slice(runner + 1);
  const slowFile = after.some((w) => /(?:^|\/)e2e\/slow-[^/]*$/.test(w));
  const e2e = after.some(
    (w, i) => w === "--project=e2e" || (w === "--project" && after[i + 1] === "e2e"),
  );
  const filtered = flagValues(after, ["--tags-filter"], 0).some((v) => v.includes("!slow"));
  return slowFile || (e2e && !filtered);
}

// why: `vitest` as the program, or after `pnpm exec`, `npx` and the like; not as an operand.
function runsAsCommand(words, runner) {
  if (runner === 0) return true;
  const launcher = ["pnpm", "npx", "bunx", "yarn", "npm"].includes(path.basename(words[0]));
  return (
    launcher &&
    words
      .slice(1, runner)
      .every((w) => ["exec", "dlx", "x", "run"].includes(w) || w.startsWith("-"))
  );
}

// why: the main session has no `agent_type`, and it may start the lane.
function startsSlowLane(words) {
  const script = words.findIndex((w) => path.basename(w) === "slow-e2e.sh");
  if (script === -1 || typeof input.agent_type !== "string") return false;
  const shell = script === 0 || ["sh", "bash", "zsh"].includes(path.basename(words[0]));
  return shell && words[script + 1] !== "status";
}

function addedLabels(words, group, verb) {
  let values = [];
  if ((group === "issue" || group === "pr") && verb === "edit")
    values = flagValues(words, ["--add-label"]);
  if ((group === "issue" || group === "pr") && verb === "create")
    values = flagValues(words, ["--label", "-l"]);
  if (group === "api") {
    values = apiFields(words)
      .filter((f) => f.key === "labels" || f.key === "labels[]")
      .map((f) => f.value);
  }
  return values.flatMap((v) => v.split(",")).map((v) => v.trim());
}

function apiPath(words) {
  for (let i = 2; i < words.length; i++) {
    if (GH_API_VALUE_FLAGS.has(words[i])) i++;
    else if (!words[i].startsWith("-")) return words[i];
  }
  return "";
}

function apiFields(words) {
  const fields = [];
  for (let i = 2; i < words.length; i++) {
    const [flag, value] = splitFlag(words, i);
    if (["-f", "-F", "--field", "--raw-field"].includes(flag) && value !== undefined) {
      const eq = value.indexOf("=");
      if (eq !== -1) fields.push({ key: value.slice(0, eq), value: value.slice(eq + 1) });
    }
  }
  return fields;
}

// why: `--flag value` and `--flag=value` are the same flag; returns [flag, value, value index].
function splitFlag(words, i) {
  const w = words[i];
  const eq = w.indexOf("=");
  if (w.startsWith("--") && eq !== -1) return [w.slice(0, eq), w.slice(eq + 1), i];
  return [w, words[i + 1], i + 1];
}

function flagValues(words, names, from = 1) {
  const values = [];
  for (let i = from; i < words.length; i++) {
    const [flag, value] = splitFlag(words, i);
    if (names.includes(flag) && value !== undefined) values.push(value);
  }
  return values;
}

function currentBranch(dir) {
  try {
    return execFileSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function squash(text) {
  return text.replace(/\s+/g, " ").trim();
}

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
  // why: the whole lane is CI's; a stage runs only the spec files its diff touched.
  if (sub === "test:console")
    return !args.includes("--project=chromium") || !after.some((w) => w.endsWith(".spec.ts"));
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

// why: the rule tables above are consts, so the hook runs once they all exist.
const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const tool = input.tool_name;
const args = input.tool_input ?? {};
const subAgent = typeof input.agent_id === "string";
const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();

if (tool === "Agent" || tool === "Task") agentRules();

if (tool === "Bash" && subAgent) {
  const shell = code(args.command ?? "");
  if (HOOK_BYPASS.some((re) => re.test(shell))) {
    refuse(
      "Refused: this skips the git hooks. They run the checks agents never run by hand. Only the " +
        "build stage may skip Fallow, on a push before its last cycle: " +
        "`LEFTHOOK_EXCLUDE=fallow git push ...`.",
    );
  }
  const raw = args.command ?? "";
  const slowLane = /slow-e2e\.sh|\.exit\b/.test(raw);
  if (!slowLane) {
    if (TEST_RUNNER.test(shell) && !(Number(args.timeout) >= 300000)) {
      refuse(
        "Refused: a test run needs `timeout: 600000` on this Bash call. The default 120 s " +
          "moves a two-minute run to the background, and a background job holds your report " +
          "until it ends. Run it again in the foreground with the timeout set.",
      );
    }
    if (args.run_in_background === true || BACKGROUND_JOB.test(shell)) {
      refuse(
        "Refused: nothing runs in the background in a delivery stage. A background job holds " +
          "your report until it ends or hits its 30-minute cap, and polling it costs the turn. " +
          "Run the command in the foreground with `timeout: 600000` on the Bash call.",
      );
    }
    if (SLEEP_LOOP.test(shell)) {
      refuse(
        "Refused: no loop that sleeps. Nothing you started runs in the background, so there is " +
          "nothing to wait for: run the command itself in the foreground with `timeout: 600000`.",
      );
    }
    if (BARE_CAT.test(raw)) {
      refuse(
        "Refused: `cat > file` with no input reads stdin until the tool times out. Write the " +
          "file with the Write tool, or give cat a heredoc (`cat > file <<'EOF'`).",
      );
    }
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
if (tool === "Bash") commandRules(args.command ?? "");
process.exit(0);

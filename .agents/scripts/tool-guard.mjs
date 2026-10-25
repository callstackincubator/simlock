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
  const found = forbiddenCheck(shell);
  if (found !== null) {
    refuse(
      `Refused: \`${found}\` is under "Checks agents never run" in toolchain.md. The commit ` +
        "hook runs lint, the comment lint and typecheck; the push hook runs Fallow and the e2e " +
        "typecheck; CI runs the rest. Their errors show in the commit or push output. Run only " +
        'the commands under "Tests agents run".',
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
}
if (tool === "Bash") commandRules(args.command ?? "");
process.exit(0);

function agentRules() {
  const type = args.subagent_type;
  const prompt = String(args.prompt ?? "");
  if (args.isolation && STAGES.has(type)) {
    refuse(
      `Refused: pass no \`isolation\` to the ${type}. Every stage of a task works in ` +
        "the task's one worktree (`.agents/scripts/worktree.sh <branch>`), one stage after " +
        "another. Start the agent again without `isolation`.",
    );
  }
  if (STAGES.has(type) && typeof args.model === "string" && args.model !== "") {
    refuse(
      `Refused: pass no \`model\` to the ${type}: it runs on the model its frontmatter pins. ` +
        "Start the agent again without `model`.",
    );
  }
  if (subAgent && args.run_in_background !== false) {
    refuse(
      "Refused: a helper agent runs in the foreground: pass `run_in_background: false`. A " +
        "background helper reports to the orchestrator, not to you, and nothing wakes you when " +
        "it ends.",
    );
  }
  if (!STAGES.has(type) && !LENSES.has(type)) return;
  if (!LEDGER.test(prompt.replace(/^\s+/, "").split("\n")[0])) {
    refuse(
      "Refused: the prompt's first line is the ledger tag (toolchain.md, \"Review " +
        'measurement"): `ledger: pr=<M> issue=<N> stage=<stage> round=<r> role=<role> ' +
        "lens=<lens>`, `-` for a key that does not apply yet. Start the agent again with it.",
    );
  }
  if (type === "implementer") briefCheck(prompt);
  if (type === "reviewer") protocolCheck(prompt);
  if (type === "code-reviewer") strictAreaCheck(prompt);
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
  if (
    at === -1 ||
    !prompt
      .slice(at)
      .split("\n")
      .some((l) => l.trim() === heading.trim())
  ) {
    refuse(
      "Refused: a reviewer's prompt carries `protocol:` and then the full text of " +
        "`docs/internal/REVIEW.md` from this checkout. Paste it and start the agent again.",
    );
  }
}

function strictAreaCheck(prompt) {
  const model = typeof args.model === "string" ? args.model : "";
  if (model === "" || /opus/i.test(model) || /\bstage=replay\b/.test(prompt)) return;
  const dir = /^inputs:\s*[`'"]?([^`'"\s]+)/m.exec(prompt)?.[1];
  if (dir === undefined) return;
  let patch;
  try {
    patch = fs.readFileSync(path.resolve(cwd, dir, "diff.patch"), "utf8");
  } catch {
    return;
  }
  const hit = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)]
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

function commandRules(raw) {
  let dir = cwd;
  const written = new Map();
  for (const cmd of parseShell(raw)) {
    const { words, dynamic } = commandWords(cmd);
    if (words.length === 0) continue;
    const name = path.basename(words[0]);
    if (name === "cd" && words[1] !== undefined && !dynamic[1]) {
      dir = path.resolve(dir, words[1].replace(/^~(?=\/|$)/, os.homedir()));
      continue;
    }
    if (name === "cat" && cmd.stdin !== null) {
      for (const r of cmd.redirects) {
        if (r.op === ">" || r.op === ">>") written.set(path.resolve(dir, r.target), cmd.stdin);
      }
    }
    if (name === "git" && subAgent) gitRules(words);
    if (name === "gh") ghRules(words, dynamic, cmd, dir, written);
    slowLaneRules(words);
  }
}

function gitRules(words) {
  let at = 1;
  while (at < words.length && words[at].startsWith("-"))
    at += GIT_VALUE_FLAGS.has(words[at]) ? 2 : 1;
  const sub = words[at];
  const rest = words.slice(at + 1);
  if (sub === "stash") {
    refuse(
      "Refused: never `git stash` in a delivery stage: every worktree shares one stash list, so " +
        "a pop can take another agent's changes. Commit the work instead.",
    );
  }
  if (
    sub === "rebase" ||
    (sub === "pull" && rest.some((w) => /^(?:-r|--rebase(?!=false))/.test(w)))
  ) {
    refuse(
      "Refused: never rebase in a delivery stage: a stack moves by merging forward " +
        "(`.agents/scripts/stack-sync.sh`), and a rebased branch needs a force push nobody may " +
        "make (delivery rule 15). Merge the base branch instead: `git merge origin/<base>`.",
    );
  }
  if (
    sub === "push" &&
    rest.some(
      (w) =>
        w.startsWith("+") ||
        /^:./.test(w) ||
        /^--(?:force|delete|mirror)/.test(w) ||
        /^-[a-zA-Z]*[fd]/.test(w),
    )
  ) {
    refuse(
      "Refused: this push rewrites or deletes a remote branch (`+<ref>`, `:<ref>`, `--force` or " +
        "`--delete`). Push fast-forwards only; when the push is rejected, merge the remote " +
        "branch in and push again.",
    );
  }
}

function ghRules(words, dynamic, cmd, dir, written) {
  const [, group, verb] = words;
  if (group === "issue" && verb === "edit" && flagValues(words, ["--add-assignee"]).length > 0) {
    refuse(
      "Refused: claim an issue with `node .agents/scripts/claim.mjs <n>` (`--triage` for a " +
        "`bug:new` triage), not by hand. It assigns you only when the issue is open, unassigned " +
        "and labelled as work an agent may take (delivery rules 1 and 2).",
    );
  }
  if (subAgent) {
    const label = addedLabels(words, group, verb).find((l) => WORK_LABELS.has(l));
    if (label !== undefined) {
      refuse(
        `Refused: agents never label their way into work (delivery rule 1): \`${label}\` is the ` +
          "maintainer's or the spec session's to set. Leave the label as it is and say in your " +
          "report what should change.",
      );
    }
    if (group === "pr" && verb === "ready") {
      refuse(
        "Refused: only the orchestrator marks a PR ready, after its review (delivery rule 14). " +
          "Leave it in draft and report.",
      );
    }
    if (group === "pr" && verb === "create") {
      if (!words.includes("--draft") && !words.includes("-d")) {
        refuse(
          "Refused: every PR starts in draft (delivery rule 14). Run `gh pr create` again with " +
            "`--draft`; the orchestrator marks it ready after review.",
        );
      }
      const head = flagValues(words, ["--head", "-H"]).at(-1) ?? currentBranch(dir);
      if (head.endsWith("-repro")) {
        refuse(
          "Refused: a `bug/<n>-repro` branch opens no pull request (delivery rule 8). Push the " +
            "test to the branch and name it in the triage report.",
        );
      }
    }
    if (group === "api" && /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls$/.test(apiPath(words))) {
      const fields = apiFields(words);
      const post =
        flagValues(words, ["-X", "--method"]).at(-1)?.toUpperCase() ??
        (fields.length > 0 ? "POST" : "GET");
      if (post === "POST" && !fields.some((f) => f.key === "draft" && f.value === "true")) {
        refuse(
          "Refused: every PR starts in draft (delivery rule 14). Create it again with " +
            "`-F draft=true`; the orchestrator marks it ready after review.",
        );
      }
    }
  }
  const body = postedBody(words, dynamic, cmd, dir, written);
  if (body === null) return;
  const defects = bodyDefects(body);
  if (defects.length > 0) {
    const reason = defects.join(" ");
    refuse(`Refused: ${reason[0].toLowerCase()}${reason.slice(1)} Fix the body and post again.`);
  }
}

// why: a body is null when the command posts none; an unreadable one refuses here.
function postedBody(words, dynamic, cmd, dir, written) {
  const [, group, verb] = words;
  const unreadable = () =>
    refuse(
      "Refused: the guard cannot read a body built by `$(...)`, a backtick or a variable, so it " +
        "cannot check its shape (delivery rule 12). Write the body to a file and pass " +
        "`--body-file <file>` (`-F body=@<file>` for `gh api`).",
    );
  const fromFile = (file) => {
    if (file === "-") {
      if (cmd.stdin === null || cmd.stdinDynamic) unreadable();
      return cmd.stdin;
    }
    const at = path.resolve(dir, file.replace(/^~(?=\/|$)/, os.homedir()));
    if (written.has(at)) return written.get(at);
    try {
      return fs.readFileSync(at, "utf8");
    } catch {
      return refuse(
        `Refused: \`${file}\` does not exist yet, so the guard cannot check the body. Write the ` +
          "file first, then post it in its own command.",
      );
    }
  };
  if (
    (group === "issue" || group === "pr") &&
    ["comment", "create", "edit", "close"].includes(verb)
  ) {
    const inline = verb === "close" ? ["--comment", "-c"] : ["--body", "-b"];
    for (let i = 3; i < words.length; i++) {
      const [flag, value, valueAt] = splitFlag(words, i);
      if (inline.includes(flag)) {
        if (dynamic[valueAt]) unreadable();
        return value ?? "";
      }
      if (verb !== "close" && (flag === "--body-file" || flag === "-F")) {
        if (dynamic[valueAt]) unreadable();
        return fromFile(value ?? "");
      }
    }
    return null;
  }
  if (group === "api") {
    for (let i = 2; i < words.length; i++) {
      const [flag, value, valueAt] = splitFlag(words, i);
      if (flag === "--input" && value !== undefined) {
        if (dynamic[valueAt]) unreadable();
        try {
          const json = JSON.parse(fromFile(value));
          if (typeof json?.body === "string") return json.body;
        } catch {
          return null;
        }
      }
      if (
        !["-f", "-F", "--field", "--raw-field"].includes(flag) ||
        !(value ?? "").startsWith("body=")
      )
        continue;
      if (dynamic[valueAt]) unreadable();
      const text = value.slice("body=".length);
      return (flag === "-F" || flag === "--field") && text.startsWith("@")
        ? fromFile(text.slice(1))
        : text;
    }
  }
  return null;
}

function slowLaneRules(words) {
  const name = path.basename(words[0]);
  const runner = words.findIndex((w) => path.basename(w) === "vitest");
  if (
    runner !== -1 &&
    (runner === 0 ||
      (["pnpm", "npx", "bunx", "yarn", "npm"].includes(name) &&
        words
          .slice(1, runner)
          .every((w) => ["exec", "dlx", "x", "run"].includes(w) || w.startsWith("-"))))
  ) {
    const after = words.slice(runner + 1);
    const slowFile = after.some((w) => /(?:^|\/)e2e\/slow-[^/]*$/.test(w));
    const e2e = after.some(
      (w, i) => w === "--project=e2e" || (w === "--project" && after[i + 1] === "e2e"),
    );
    const filtered = flagValues(after, ["--tags-filter"], 0).some((v) => v.includes("!slow"));
    if (slowFile || (e2e && !filtered)) {
      refuse(
        "Refused: the slow lane runs only through `scripts/slow-e2e.sh <test files>`, which holds " +
          "the machine-wide lock (delivery rule 16). Run the fast e2e lane with `pnpm test:e2e " +
          "<files>`, and leave the slow lane to the hardware verifier.",
      );
    }
  }
  if (
    subAgent &&
    name === "pnpm" &&
    SLOW_LANE_SCRIPTS.has(pnpmOperands(words.slice(1)).find((w) => w !== "run"))
  ) {
    refuse(
      "Refused: the slow lane runs only through `scripts/slow-e2e.sh <test files>`, which holds " +
        "the machine-wide lock (delivery rule 16). Run it through the script, or report the " +
        "lines that need it under `hardware`.",
    );
  }
  const script = words.findIndex((w) => path.basename(w) === "slow-e2e.sh");
  if (
    script !== -1 &&
    (script === 0 || ["sh", "bash", "zsh"].includes(name)) &&
    words[script + 1] !== "status" &&
    typeof input.agent_type === "string" &&
    !SLOW_LANE_AGENTS.has(input.agent_type)
  ) {
    refuse(
      "Refused: only the hardware verifier and the implementer run the slow lane (delivery rule " +
        "16); `scripts/slow-e2e.sh status` is open to every agent. Report what needs the lane " +
        "instead.",
    );
  }
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

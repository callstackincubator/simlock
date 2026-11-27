import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "tool-guard.mjs",
);

function call(input: object): { status: number | null; stderr: string } {
  const result = spawnSync("node", [SCRIPT], { input: JSON.stringify(input), encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FOOTER = "*Written by an agent.*";
const LEDGER = "ledger: pr=975 issue=966 stage=build round=- role=implementer lens=-";

// why: the timeout is set so each case meets the one rule it names, not the test-run timeout.
function bash(
  command: string,
  agentId: string | null = "a1",
  agentType = "reviewer",
  extra: { cwd?: string; timeout?: number } = {},
) {
  return call({
    tool_name: "Bash",
    tool_input: { command, timeout: extra.timeout ?? 600000 },
    ...(extra.cwd !== undefined && { cwd: extra.cwd }),
    ...(agentId && { agent_id: agentId, agent_type: agentType }),
  });
}

// why: what the hook answers on stdout when it changes a call or adds context to it.
function answered(input: object): {
  status: number | null;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
} {
  const result = spawnSync("node", [SCRIPT], { input: JSON.stringify(input), encoding: "utf8" });
  const output = result.stdout === "" ? {} : JSON.parse(result.stdout).hookSpecificOutput;
  return {
    status: result.status,
    updatedInput: output.updatedInput,
    additionalContext: output.additionalContext,
  };
}

// why: a push's target depends on the branch, its upstream and `push.default`, so each case
// gets a repository of its own; nothing is ever pushed.
function checkout(branch: string, config: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-guard-repo-"));
  execFileSync("git", ["init", "-q", "-b", branch, dir]);
  for (const [key, value] of Object.entries({ "push.default": "simple", ...config }))
    execFileSync("git", ["-C", dir, "config", key, value]);
  return slashed(dir);
}

// why: how the branch of the 2026-11-20 push stood: cut from `origin/main`, so it tracked it,
// on a machine whose `push.default` is `upstream`.
function tracksMain(branch: string, pushDefault = "upstream"): string {
  return checkout(branch, {
    "push.default": pushDefault,
    [`branch.${branch}.remote`]: "origin",
    [`branch.${branch}.merge`]: "refs/heads/main",
  });
}

function agent(toolInput: object, agentId: string | null = null) {
  return call({ tool_name: "Agent", tool_input: toolInput, ...(agentId && { agent_id: agentId }) });
}

// why: a command line names a path with "/" on every host, as a shell does; the guard reads "\\"
// as an escape.
function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

function bodyFile(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "tool-guard-")), "body.md");
  writeFileSync(file, body);
  return slashed(file);
}

const OK = { status: 0, stderr: "" };

// why: the prompt the agent receives when the hook changed it, else the hook's status.
function sent(type: string, prompt: string, agentId?: string) {
  const result = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({
      tool_name: "Agent",
      tool_input: { subagent_type: type, prompt, run_in_background: false },
      ...(agentId !== undefined && { agent_id: agentId }),
    }),
    encoding: "utf8",
  });
  if (result.stdout === "") return { status: result.status, stderr: result.stderr };
  return JSON.parse(result.stdout).hookSpecificOutput.updatedInput.prompt as string;
}

// why: a `##` section of a rule file as it stands in this checkout, cut by its headings.
function section(file: string, heading: string, next: string): string {
  const text = readFileSync(join(ROOT, "docs", "internal", "agent-rules", file), "utf8");
  return text.slice(text.indexOf(heading), text.indexOf(next)).trim();
}

describe("tool-guard.mjs", () => {
  it.each([
    "pnpm check",
    "pnpm run fallow",
    "pnpm test",
    "pnpm typecheck:e2e",
    "pnpm exec oxfmt src/a.ts",
    "npx -y tsc --noEmit -p e2e",
    "node_modules/.bin/oxlint src",
    "node .agents/scripts/comment-lint.mjs --base origin/main",
    "pnpm test:e2e",
    "pnpm test:console",
    "sed -i '' 's/a/b/' f.ts && pnpm check 2>&1 | tail -5",
    "timeout 100 pnpm fallow",
    "pnpm tsc -p e2e/tsconfig.typecheck.json --noEmit",
    "pnpm exec tsc --noEmit src/a.ts",
    "pnpm oxlint src",
    "pnpm exec depcruise src e2e ui --ignore-known",
    "pnpm --dir . check",
    "pnpm --workspace check",
    "pnpm -C . run lint",
    "(FORCE_COLOR=0 pnpm lint | tail -3)",
    "pnpm mutate origin/main",
    "node scripts/mutate.mjs origin/main",
    "pnpm exec stryker run",
  ])("refuses a sub-agent's check: %s", (command) => {
    const result = bash(command);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Checks agents never run");
  });

  it.each([
    "pnpm test:changed",
    "pnpm typecheck",
    "pnpm run typecheck",
    "pnpm exec vitest run --project unit src/a.test.ts",
    "pnpm test:e2e e2e/http-api.test.ts",
    "pnpm test:console --project=chromium e2e/console/sign-in.spec.ts",
    "pnpm mutate --touched-by refactor-draft-12",
    'git commit -qm "run pnpm check in CI"',
    'git commit -m "chore(fallow): remove four stale suppressions"',
    'gh pr edit 5 --title "chore(fallow): x"',
    "echo 'a; pnpm check'",
    "sed -i '' 's/oxfmt/oxlint/' docs/a.md",
    "grep -n tsc package.json",
    "python3 - <<'E'\nprint(\"pnpm check\")\nE\ngit status --short",
    "cat > x.sh <<EOF\npnpm check\nEOF\nchmod +x x.sh",
  ])("lets a sub-agent run a test, or a command that only names a check: %s", (command) => {
    expect(bash(command)).toEqual({ status: 0, stderr: "" });
  });

  it.each([
    ["ls", { run_in_background: true, timeout: 600_000 }, "background"],
    ["pnpm test:changed", { run_in_background: true }, "background"],
    ["(git push origin x > log 2>&1; echo done) &", { timeout: 600_000 }, "background"],
    ["until ! pgrep -f lefthook >/dev/null; do sleep 5; done; tail x", {}, "loop that sleeps"],
    ["for _ in $(seq 18); do [ -f out ] && break; sleep 30; done", {}, "loop that sleeps"],
    ["cat > /tmp/x 2>/dev/null; mkdir -p .agents/scratch", {}, "no input"],
    ["cat > ../pr-911.md", {}, "no input"],
  ])("refuses a sub-agent's wait or background job: %s", (command, input, reason) => {
    const result = call({
      tool_name: "Bash",
      tool_input: { command, ...input },
      agent_id: "a1",
      agent_type: "implementer",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it.each([
    "ls vitest* ui/vitest.config.ts",
    "cat vitest.config.ts | head",
    'for _ in $(seq 18); do [ -f "$log.exit" ] && break; sleep 30; done; cat "$log.exit"',
    "cat > ../pr-911.md <<'EOF'\nCloses #1\nEOF\ngit status",
    "python3 - <<'EOF'\nfor i in range(3):\n  time.sleep(1)\nEOF",
  ])("lets a sub-agent run a foreground command, the slow lane wait included: %s", (command) => {
    expect(bash(command, "a1", "implementer")).toEqual(OK);
  });

  it.each([
    "git push --no-verify -u origin task/1",
    "git commit -q --no-verify -m x",
    "LEFTHOOK=0 git push origin HEAD:task/1",
    "git -c core.hooksPath=/dev/null push",
    "LEFTHOOK_EXCLUDE=typecheck-e2e git push",
  ])("refuses a sub-agent's skip of the git hooks: %s", (command) => {
    const result = bash(command);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("skips the git hooks");
  });

  it("lets a build stage skip Fallow alone on a push", () => {
    expect(bash("LEFTHOOK_EXCLUDE=fallow git push -u origin task/1")).toEqual({
      status: 0,
      stderr: "",
    });
  });

  it("lets the main session run a check, as a routine does", () => {
    expect(bash("pnpm mutate origin/main", null)).toEqual({ status: 0, stderr: "" });
  });

  it.each(["implementer", "reviewer", "hardware-verifier"])(
    "refuses to start a %s in its own worktree",
    (agent) => {
      const result = call({
        tool_name: "Agent",
        tool_input: { subagent_type: agent, isolation: "worktree", prompt: "issue: 1" },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("pass no `isolation`");
    },
  );

  it("starts a stage agent without isolation, and another agent with it", () => {
    expect(agent({ subagent_type: "hardware-verifier", prompt: `${LEDGER}\npr: 975` })).toEqual(OK);
    expect(agent({ subagent_type: "general-purpose", isolation: "worktree", prompt: "x" })).toEqual(
      OK,
    );
  });

  it.each([
    ["pnpm exec vitest run --project unit src/a.test.ts 2>&1 | tail -30", {}],
    ["pnpm test:changed", { timeout: 120_000 }],
    ["cd ui && pnpm exec playwright test e2e/console/sign-in.spec.ts", { timeout: 200_000 }],
  ])("gives a sub-agent's test run the long timeout, and says so: %s", (command, given) => {
    const toolInput = { command, description: "run the test", ...given };

    const result = answered({ tool_name: "Bash", tool_input: toolInput, agent_id: "a1" });

    expect(result.status).toBe(0);
    expect(result.updatedInput).toEqual({ ...toolInput, timeout: 600000 });
    expect(result.additionalContext).toContain("set `timeout: 600000` on this Bash call");
  });

  it("leaves alone a test run that has the long timeout, and the main session's", () => {
    const toolInput = { command: "pnpm test:changed", timeout: 600000 };

    expect(answered({ tool_name: "Bash", tool_input: toolInput, agent_id: "a1" })).toEqual({
      status: 0,
    });
    expect(answered({ tool_name: "Bash", tool_input: { command: "pnpm test:changed" } })).toEqual({
      status: 0,
    });
  });

  it.each([
    ["pnpm exec tsc --noEmit -p . 2>&1 | head -30", "pnpm typecheck 2>&1 | head -30"],
    ["pnpm exec tsc --noEmit", "pnpm typecheck"],
    ["timeout 300 npx tsc --noEmit -p .", "timeout 300 pnpm typecheck"],
    [
      "./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | tail -5; echo tsc-exit=$?",
      "pnpm typecheck 2>&1 | tail -5; echo tsc-exit=$?",
    ],
    ["npx tsc -p ui/tsconfig.json --noEmit", "pnpm typecheck"],
    [
      "(pnpm exec tsc --noEmit -p . 2>&1 | tail -15); pnpm exec tsc --noEmit | grep -c TS",
      "(pnpm typecheck 2>&1 | tail -15); pnpm typecheck | grep -c TS",
    ],
    [
      'git commit -qm "fix: pnpm exec tsc --noEmit passes" && pnpm exec tsc --noEmit',
      'git commit -qm "fix: pnpm exec tsc --noEmit passes" && pnpm typecheck',
    ],
    [
      "cat > note.md <<'EOF'\nnpx tsc --noEmit\nEOF\nnpx tsc --noEmit",
      "cat > note.md <<'EOF'\nnpx tsc --noEmit\nEOF\npnpm typecheck",
    ],
  ])("runs pnpm typecheck in place of a sub-agent's %s, and says so", (command, repaired) => {
    const toolInput = { command, timeout: 600000 };

    const result = answered({
      tool_name: "Bash",
      tool_input: toolInput,
      agent_id: "a1",
      cwd: slashed(ROOT),
    });

    expect(result.status).toBe(0);
    expect(result.updatedInput).toEqual({ ...toolInput, command: repaired });
    expect(result.additionalContext).toContain("`pnpm typecheck` in place of");
  });

  it.each([
    "tsc --noEmit",
    "node_modules/.bin/tsc --noEmit",
    "./node_modules/.bin/tsc --noEmit",
    `${slashed(ROOT)}/node_modules/.bin/tsc --noEmit`,
    "D:/a/simlock/simlock/node_modules/.bin/tsc --noEmit",
    "C:/Users/RUNNER~1/simlock/node_modules/.bin/tsc --noEmit -p .",
    "pnpm tsc --noEmit",
    "pnpm exec tsc --noEmit",
    "npx tsc --noEmit",
    "npx -y tsc --noEmit",
    "npx --yes tsc --noEmit",
    "npx --no-install tsc --noEmit",
    "tsc -p . --noEmit",
    "tsc --noEmit --project .",
    "tsc --noEmit -p ./",
    "tsc --noEmit -p tsconfig.json",
    "tsc --noEmit -p ./tsconfig.json",
    "tsc --noEmit -p ui",
    "tsc -p ui/tsconfig.json --noEmit",
    "tsc --noEmit -p packages/e2e",
    "tsc --noEmit -p packages/e2e/tsconfig.json",
  ])("takes %s for a type check pnpm typecheck replaces", (command) => {
    const result = answered({
      tool_name: "Bash",
      tool_input: { command, timeout: 600000 },
      agent_id: "a1",
      cwd: slashed(ROOT),
    });

    expect(result.updatedInput).toEqual({ command: "pnpm typecheck", timeout: 600000 });
  });

  // why: each row is the nearest call to an accepted form that runs tsc somewhere else, with
  // other files or another project; the last two hold a run the pattern finds but must not swap.
  it.each([
    "tsc -p .",
    "tsc --noEmit --watch",
    "tsc --noEmit src/a.ts",
    "tsc --noEmit false",
    "scripts/tsc --noEmit",
    "D:/a/simlock/simlock/scripts/tsc --noEmit",
    "pnpm exec node_modules/.bin/tsc --noEmit",
    "pnpm run tsc --noEmit",
    "pnpm dlx tsc --noEmit",
    "pnpm -r tsc --noEmit",
    "pnpm -r exec tsc --noEmit",
    "pnpm --dir packages/e2e exec tsc --noEmit",
    "pnpm --dir=packages/e2e exec tsc --noEmit -p .",
    "pnpm -C=ui exec tsc --noEmit",
    "pnpm --filter=simlock exec tsc --noEmit",
    "npx --prefix=/tmp tsc --noEmit",
    "npx --prefix /tmp tsc --noEmit",
    "npx -p typescript tsc --noEmit",
    "npx -y -p typescript tsc --noEmit",
    "npx --no tsc --noEmit",
    "bunx tsc --noEmit",
    "tsc --noEmit -p e2e",
    "tsc --noEmit -p e2e/tsconfig.typecheck.json",
    "tsc --noEmit -p website",
    "tsc --noEmit --project=.",
    "tsc --noEmit -p . -p ui",
    "tsc --noEmit -p",
    'pnpm --dir=ui exec tsc --noEmit; tsc --noEmit -p "."',
    "pnpm exec tsc --noEmit # was: npx tsc --noEmit",
  ])("never rewrites %s", (command) => {
    const result = answered({
      tool_name: "Bash",
      tool_input: { command, timeout: 600000 },
      agent_id: "a1",
      cwd: slashed(ROOT),
    });

    expect(result.updatedInput).toBeUndefined();
  });

  it.each([
    "pnpm --dir=packages/e2e exec tsc --noEmit -p .",
    "pnpm -C=ui exec tsc --noEmit",
    "pnpm --filter=simlock exec tsc --noEmit",
    "npx --prefix=/tmp tsc --noEmit",
  ])("refuses %s, whose launcher flag names another place to run", (command) => {
    const result = bash(command, "a1", "implementer", { cwd: slashed(ROOT) });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`\`${command}\` is under "Checks agents never run"`);
  });

  it("refuses a sub-agent's tsc where pnpm typecheck is not the same check", () => {
    const elsewhere = slashed(mkdtempSync(join(tmpdir(), "tool-guard-scratch-")));
    const reason = "for types that is `pnpm typecheck`";

    expect(bash("pnpm exec tsc --noEmit -p e2e").stderr).toContain(reason);
    expect(bash("pnpm exec tsc --noEmit", "a1", "reviewer", { cwd: elsewhere }).stderr).toContain(
      reason,
    );
    expect(bash(`cd ${elsewhere} && npx tsc --noEmit -p .`).stderr).toContain(reason);
    expect(bash('cd "$W" && pnpm exec tsc --noEmit').stderr).toContain(reason);
    expect(bash('cd "$W" && cd src && cd .. && pnpm exec tsc --noEmit').stderr).toContain(reason);
    expect(bash("pnpm exec tsc --noEmit -p . && pnpm exec tsc --noEmit -p e2e").stderr).toContain(
      "`pnpm exec tsc --noEmit -p e2e`",
    );
  });

  it("refuses the push that landed on main on 2026-11-20, from a sub-agent and from the main session", () => {
    const cwd = tracksMain("bug/1790-repro");
    const command = "git push -u origin bug/1790-repro 2>&1 | tail -8";

    for (const agentId of ["a1", null]) {
      const result = bash(command, agentId, "bug-triager", { cwd });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("this push lands on `main`");
    }
  });

  it.each([
    ["git push origin main", checkout("task/1")],
    ["git push -u origin main 2>&1 | tail -3", checkout("task/1")],
    ["git push origin HEAD:main", checkout("task/1")],
    ["git push origin 5b688e1ce:main", checkout("task/1")],
    ["git push origin :refs/heads/main", checkout("task/1")],
    ["git push -u origin HEAD:refs/heads/main", checkout("task/1")],
    ["git push origin task/1 +task/2:main", checkout("task/1")],
    ["git push --all origin", checkout("task/1")],
    ["git push", tracksMain("task/1")],
    ["git push -u origin", tracksMain("task/1")],
    ["git push origin refs/heads/task/1", tracksMain("task/1")],
    ['git push -u origin "$(git branch --show-current)"', tracksMain("task/1")],
    ["git push origin HEAD", checkout("main")],
    ["git push", checkout("main")],
  ])("refuses %s when it lands on main", (command, cwd) => {
    for (const agentId of ["a1", null]) {
      const result = bash(command, agentId, "implementer", { cwd });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("this push lands on `main`");
    }
    expect(bash(`git -C ${cwd} ${command.slice("git ".length)}`, null).status).toBe(2);
  });

  it.each([
    ["git push -u origin task/1", checkout("task/1")],
    ["git push", checkout("task/1")],
    ["git push -u origin bug/1790-repro", tracksMain("bug/1790-repro", "simple")],
    ["git push -u origin HEAD:refs/heads/bug/1790-repro", tracksMain("bug/1790-repro")],
    ["git push -u origin bug/1790-repro:bug/1790-repro", tracksMain("bug/1790-repro")],
    ["git push origin HEAD", tracksMain("task/1")],
    ["git push origin main:task/1", checkout("task/1")],
    ["git push origin task/1:refs/heads/docs/main", checkout("task/1")],
    ["git push fork HEAD:main", checkout("task/1")],
    ["git push origin --tags", checkout("main")],
    ['git commit -m "docs: never git push origin main"', checkout("task/1")],
  ])("lets %s through when it lands on another branch", (command, cwd) => {
    expect(bash(command, "a1", "implementer", { cwd })).toEqual(OK);
    expect(bash(command, null, "implementer", { cwd })).toEqual(OK);
  });

  it.each([
    ["git stash push -u", "never `git stash`"],
    ["git stash", "never `git stash`"],
    ["git -C ../x stash pop", "never `git stash`"],
    ["git rebase origin/main", "never rebase"],
    ["git pull --rebase origin task/1", "never rebase"],
    ["git push origin +task/1", "rewrites or deletes a remote branch"],
    ["git push origin +HEAD:task/1", "rewrites or deletes a remote branch"],
    ["git push origin :task/1", "rewrites or deletes a remote branch"],
    ["git push --delete origin task/1", "rewrites or deletes a remote branch"],
    ["git -C ../x push --force-with-lease origin task/1", "rewrites or deletes a remote branch"],
  ])("refuses a sub-agent's %s", (command, reason) => {
    const result = bash(command, "a1", "implementer");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it.each([
    "git push -u origin task/1",
    "git push origin HEAD:task/1",
    "git merge origin/main",
    "git stash list",
    "git -C ../x stash show -p stash@{0}",
    'git commit -m "test: never git stash or git rebase (#1)"',
  ])("lets a sub-agent run %s", (command) => {
    expect(bash(command, "a1", "implementer")).toEqual(OK);
  });

  it("lets the main session stash and rebase", () => {
    expect(bash("git stash push -u -m tag && git rebase origin/main", null)).toEqual(OK);
  });

  it("refuses a sub-agent's PR that is not a draft, or comes from a -repro branch, and its gh pr ready", () => {
    const body = bodyFile(`Closes #1\n\n${FOOTER}\n`);
    const repro = slashed(mkdtempSync(join(tmpdir(), "tool-guard-repro-")));
    execFileSync("git", ["init", "-q", "-b", "bug/5-repro", repro]);

    expect(
      bash(`gh pr create --title x --body-file ${body}`, "a1", "implementer").stderr,
    ).toContain("every PR starts in draft");
    expect(
      bash("gh api -X POST repos/o/r/pulls -f title=x -f head=task/1 -f base=main", "a1").stderr,
    ).toContain("every PR starts in draft");
    expect(bash("gh pr ready 975", "a1", "implementer").stderr).toContain(
      "only the orchestrator marks a PR ready",
    );
    expect(
      bash(`gh pr create --draft --head bug/5-repro --body-file ${body}`, "a1", "bug-triager")
        .stderr,
    ).toContain("opens no pull request");
    expect(
      bash(`gh pr create --draft --body-file ${body}`, "a1", "bug-triager", { cwd: repro }).stderr,
    ).toContain("opens no pull request");

    expect(bash(`gh pr create --draft --title x --body-file ${body}`, "a1", "implementer")).toEqual(
      OK,
    );
    expect(
      bash("gh api -X POST repos/o/r/pulls -f title=x -f head=task/1 -F draft=true", "a1"),
    ).toEqual(OK);
    expect(bash("gh pr ready 975", null)).toEqual(OK);
  });

  it.each([
    "gh issue edit 9 --add-label bug:ready --remove-label bug:new",
    "gh issue edit 9 --add-label=task:ready",
    "gh issue edit 9 --add-label x,feature:planned",
    "gh issue edit 9 --add-label refactor:ready --remove-label refactor:new",
    "gh issue create --title x --label task:ready --body-file b.md",
    "gh api -X POST repos/o/r/issues/9/labels -f 'labels[]=bug:ready'",
  ])("refuses a sub-agent's label into work: %s", (command) => {
    const result = bash(command, "a1", "bug-triager");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("never label their way into work");
  });

  it("lets a sub-agent move a bug to needs-info, and the main session set a ready label", () => {
    expect(
      bash(
        "gh issue edit 9 --add-label bug:needs-info --remove-label bug:new",
        "a1",
        "bug-triager",
      ),
    ).toEqual(OK);
    expect(bash("gh issue edit 9 --add-label task:ready --remove-label task:draft", null)).toEqual(
      OK,
    );
  });

  it.each([null, "a1"])("refuses a claim by hand from any session (agent %s)", (agentId) => {
    const result = bash("gh issue edit 9 --add-assignee @me", agentId);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("node .agents/scripts/claim.mjs <n>");
    expect(bash("gh issue edit 9 --remove-assignee @me", agentId)).toEqual(OK);
  });

  it.each([
    ["pnpm exec vitest run --project e2e e2e/slow-ios.test.ts", null],
    ["pnpm exec vitest run --project e2e --tags-filter='!slow' e2e/slow-ios.test.ts", "a1"],
    ["npx vitest run --project=e2e e2e/http-api.test.ts", "a1"],
    ["node_modules/.bin/vitest run --project e2e", null],
  ])("refuses a slow-lane test outside its script: %s", (command, agentId) => {
    const result = bash(command, agentId);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("runs only through `scripts/slow-e2e.sh");
  });

  it("refuses fast-track.mjs to the agents whose report or fix it checks, and lets the others run it", () => {
    const command = "node .agents/scripts/fast-track.mjs 5";

    expect(bash(command, "a1", "bug-triager").stderr).toContain("you never run it yourself");
    expect(bash(`${command} --pr 9`, "a1", "implementer").status).toBe(2);
    expect(
      bash("env GH_REPO=o/r .agents/scripts/fast-track.mjs 5", "a1", "implementer").status,
    ).toBe(2);
    expect(bash("git add .agents/scripts/fast-track.mjs", "a1", "implementer")).toEqual(OK);
    expect(bash("cat .agents/scripts/fast-track.mjs", "a1", "bug-triager")).toEqual(OK);
    expect(bash(command, "a1", "general-purpose")).toEqual(OK);
    expect(bash(command, null)).toEqual(OK);
  });

  it.each([
    "gh issue edit 5 --remove-label fast-track",
    "gh issue edit 5 --add-label bug:blocked --remove-label bug:ready,fast-track",
    "gh api -X DELETE repos/o/r/issues/5/labels/fast-track",
    "gh api --method PUT repos/o/r/issues/5/labels -f labels[]=bug:blocked",
  ])("refuses a sub-agent that takes a bug off the fast track: %s", (command) => {
    const result = bash(command, "a1", "implementer");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("only the maintainer takes a bug off the fast track");
  });

  it("lets the main session remove fast-track, and a sub-agent remove another label", () => {
    expect(bash("gh issue edit 5 --remove-label fast-track", null)).toEqual(OK);
    expect(bash("gh issue edit 5 --remove-label bug:new", "a1", "bug-triager")).toEqual(OK);
    expect(bash("gh api -X DELETE repos/o/r/issues/5/labels/bug:new", "a1", "reviewer")).toEqual(
      OK,
    );
  });

  it("refuses the slow lane's pnpm scripts in a sub-agent, and slow-e2e.sh outside its two agents", () => {
    expect(bash("pnpm test:e2e:slow e2e/slow-ios.test.ts", "a1", "implementer").stderr).toContain(
      "runs only through `scripts/slow-e2e.sh",
    );
    expect(bash("scripts/slow-e2e.sh e2e/slow-ios.test.ts", "a1", "bug-triager").stderr).toContain(
      "only the hardware verifier and the implementer run the slow lane",
    );
    expect(bash("sh scripts/slow-e2e.sh clean", "a1", "code-reviewer").status).toBe(2);
  });

  it.each([
    [
      "pnpm exec vitest run --project e2e --tags-filter='!slow' e2e/http-api.test.ts",
      "a1",
      "reviewer",
    ],
    ["scripts/slow-e2e.sh status", "a1", "bug-triager"],
    ["scripts/slow-e2e.sh e2e/slow-ios.test.ts", "a1", "hardware-verifier"],
    ["scripts/slow-e2e.sh --physical e2e/slow-ios-physical.test.ts", "a1", "implementer"],
    ["scripts/slow-e2e.sh e2e/slow-ios.test.ts", null, "reviewer"],
    ["ls e2e/slow-ios.test.ts vitest.config.ts", "a1", "reviewer"],
  ])("lets %s run (agent %s, %s)", (command, agentId, agentType) => {
    expect(bash(command, agentId, agentType)).toEqual(OK);
  });

  it("refuses a sub-agent's helper agent unless it runs in the foreground", () => {
    for (const background of [undefined, true]) {
      const result = agent(
        { subagent_type: "Explore", prompt: "x", run_in_background: background },
        "a1",
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("pass `run_in_background: false`");
    }
    expect(
      agent({ subagent_type: "Explore", prompt: "x", run_in_background: false }, "a1"),
    ).toEqual(OK);
    expect(agent({ subagent_type: "Explore", prompt: "x" })).toEqual(OK);
  });

  it.each(["implementer", "reviewer", "hardware-verifier"])(
    "refuses a model on the %s from any session",
    (type) => {
      const result = agent({ subagent_type: type, model: "opus", prompt: LEDGER });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`pass no \`model\` to the ${type}`);
    },
  );

  it.each([
    "implementer",
    "reviewer",
    "hardware-verifier",
    "spec-reviewer",
    "code-reviewer",
    "claims-reviewer",
  ])("refuses to start a %s whose prompt does not begin with the ledger tag", (type) => {
    const result = agent(
      { subagent_type: type, prompt: "issue: 966\nmode: build", run_in_background: false },
      type.endsWith("-reviewer") ? "a1" : null,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("first line is the ledger tag");
  });

  it("adds an implementer's brief, a reviewer's protocol and a lens's pinned briefs to the prompt the agent receives", () => {
    const build = readFileSync(join(ROOT, ".agents", "briefs", "implement-build.md"), "utf8");
    const protocol = readFileSync(join(ROOT, "docs", "internal", "REVIEW.md"), "utf8");
    const inputs = mkdtempSync(join(tmpdir(), "tool-guard-briefs-"));
    mkdirSync(join(inputs, "briefs"));
    writeFileSync(join(inputs, "briefs", "review-later-round.md"), "LATER pinned\n");
    writeFileSync(join(inputs, "briefs", "review-claims.md"), "CLAIMS pinned\n");
    const lensTag = "ledger: pr=975 issue=966 stage=review round=2 role=claims lens=-";

    expect(sent("implementer", `${LEDGER}\nissue: 966\nmode: build`)).toBe(
      `${LEDGER}\nissue: 966\nmode: build\nbrief:\n${build}`,
    );
    expect(sent("implementer", `${LEDGER}\nissue: 966\nmode: build\nbrief:\n${build}`)).toEqual(OK);
    expect(sent("implementer", `${LEDGER}\nissue: 966`)).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("`mode:` line"),
    });
    expect(sent("reviewer", `${LEDGER}\npr: 975`)).toBe(
      `${LEDGER}\npr: 975\nprotocol:\n${protocol}`,
    );
    expect(sent("reviewer", `${LEDGER}\npr: 975\nprotocol:\n${protocol}`)).toEqual(OK);
    expect(sent("claims-reviewer", `${lensTag}\ninputs: ${inputs}\nround: 2`, "a1")).toBe(
      `${lensTag}\ninputs: ${inputs}\nround: 2\n=== briefs/review-later-round.md ===\nLATER pinned\n\n=== briefs/review-claims.md ===\nCLAIMS pinned\n\n`,
    );
    expect(sent("claims-reviewer", `${lensTag}\ninputs: ${inputs}\nround: 1`, "a1")).toBe(
      `${lensTag}\ninputs: ${inputs}\nround: 1\n=== briefs/review-claims.md ===\nCLAIMS pinned\n\n`,
    );
    expect(sent("claims-reviewer", `${lensTag}\ninputs: ${inputs}/gone\nround: 1`, "a1")).toEqual(
      OK,
    );
  });

  it("gives a reviewer whose prompt names inputs the protocol pinned there, and this checkout's when there is none", () => {
    const protocol = readFileSync(join(ROOT, "docs", "internal", "REVIEW.md"), "utf8");
    const inputs = slashed(mkdtempSync(join(tmpdir(), "tool-guard-protocol-")));
    writeFileSync(join(inputs, "review-protocol.md"), "PROTOCOL pinned\n");
    const replay = `${LEDGER}\npr: 975\nreplay: true\ninputs: `;

    expect(sent("reviewer", `${replay}${inputs}`)).toBe(
      `${replay}${inputs}\nprotocol:\nPROTOCOL pinned\n`,
    );
    expect(sent("reviewer", `${replay}${inputs}/gone`)).toBe(
      `${replay}${inputs}/gone\nprotocol:\n${protocol}`,
    );
  });

  it("adds the pinned Tests agents run table to a code lens's prompt, after its brief", () => {
    const inputs = slashed(mkdtempSync(join(tmpdir(), "tool-guard-rules-")));
    mkdirSync(join(inputs, "briefs"));
    mkdirSync(join(inputs, "rules"));
    writeFileSync(join(inputs, "briefs", "review-code.md"), "CODE pinned\n");
    writeFileSync(
      join(inputs, "rules", "toolchain.md"),
      "# Toolchain\n\n## Tests agents run\n\nTABLE pinned\n\n## Code search\n\nSEARCH\n",
    );
    const prompt = `ledger: pr=975 issue=966 stage=review round=1 role=code lens=behaviour\ninputs: ${inputs}\nround: 1`;

    expect(sent("code-reviewer", prompt, "a1")).toBe(
      `${prompt}\n=== briefs/review-code.md ===\nCODE pinned\n\n` +
        '=== toolchain.md, "Tests agents run", in full ===\n## Tests agents run\n\nTABLE pinned\n',
    );
  });

  it("adds this checkout's Slow lane section to a hardware verifier's prompt, once", () => {
    const slowLane = section("toolchain.md", "## Slow lane", "## Other tools' source");
    const prompt = "ledger: pr=975 issue=966 stage=hardware round=- role=hardware lens=-\npr: 975";
    const added = `${prompt}\n=== toolchain.md, "Slow lane", in full ===\n${slowLane}\n`;

    expect(sent("hardware-verifier", prompt)).toBe(added);
    expect(sent("hardware-verifier", added)).toEqual(OK);
  });

  it("adds the test commands, testing rule 10 and delivery rules 8 and 17 to a bug triager's prompt", () => {
    const tests = section("toolchain.md", "## Tests agents run", "## Code search");
    const delivery = readFileSync(
      join(ROOT, "docs", "internal", "agent-rules", "delivery.md"),
      "utf8",
    );
    const rule = (from: string, to: string) =>
      delivery.slice(delivery.indexOf(`\n${from}. **`) + 1, delivery.indexOf(`\n${to}. **`)).trim();

    const prompt = sent("bug-triager", "issue: 1790") as string;

    expect(prompt).toContain(`=== toolchain.md, "Tests agents run", in full ===\n${tests}\n`);
    expect(prompt).toMatch(
      /=== testing\.md, rule 10, in full ===\n10\. \*\*[^\n]+\n[\s\S]+\n=== delivery/,
    );
    expect(prompt).toContain(`=== delivery.md, rule 8, in full ===\n${rule("8", "9")}\n`);
    expect(prompt).toContain(`=== delivery.md, rule 17, in full ===\n${rule("17", "18")}\n`);
  });

  it("refuses a code review off Opus on a diff that touches a strict area, outside a replay", () => {
    const inputs = mkdtempSync(join(tmpdir(), "tool-guard-inputs-"));
    const plain = join(inputs, "plain");
    const strict = join(inputs, "strict");
    for (const [dir, path] of [
      [plain, "src/cli/main.ts"],
      [strict, "src/leasing/wait-queue.ts"],
    ] as const) {
      mkdirSync(dir);
      writeFileSync(join(dir, "diff.patch"), `diff --git a/${path} b/${path}\n+x\n`);
    }
    const lens = (dir: string, model?: string, stage = "review") =>
      agent(
        {
          subagent_type: "code-reviewer",
          ...(model !== undefined && { model }),
          run_in_background: false,
          prompt: `ledger: pr=975 issue=966 stage=${stage} round=1 role=code lens=both\ninputs: ${dir}`,
        },
        "a1",
      );

    expect(lens(strict, "sonnet").stderr).toContain("`src/leasing/wait-queue.ts`");
    expect(lens(strict, "opus")).toEqual(OK);
    expect(lens(strict)).toEqual(OK);
    expect(lens(strict, "sonnet", "replay")).toEqual(OK);
    expect(lens(plain, "sonnet")).toEqual(OK);
  });

  const handoff = (blocked = "nothing") =>
    `## Handoff\n\n**Done:** two cycles, green.\n**Not done:** the rest.\n**Findings:** none.\n**Blocked on:** ${blocked}\n\n${FOOTER}\n`;
  const triage = [
    "## Reproduction",
    "`src/a.test.ts` fails.",
    "## Root cause",
    "Defect: `src/a.ts:12` drops the lease.",
    "## Simplest fix",
    "Keep it.",
    "## Alternatives rejected",
    "- a — no",
    "## Risk",
    "- b",
    "## Fast track",
    "- Defect: yes",
    "- Fix tried: yes",
    "- Nothing public added or broken: yes",
    "- No ADR or rule changed: yes",
    "- One fix: no — agent-device could carry the fix",
    "",
    FOOTER,
  ].join("\n");

  it.each([
    ["no footer", "Done.", "ends with the line `*Written by an agent.*`"],
    ["a handoff part missing", handoff().replace("**Findings:** none.\n", ""), "has four parts"],
    [
      "handoff parts out of order",
      handoff().replace(
        "**Done:** two cycles, green.\n**Not done:** the rest.",
        "**Not done:** the rest.\n**Done:** x",
      ),
      "has four parts",
    ],
    [
      "a handoff over 150 words",
      handoff().replace("the rest.", "word ".repeat(150)),
      "the budget is 150",
    ],
    [
      "a triage report without Risk",
      triage.replace("## Risk\n- b\n", ""),
      "a triage report has the sections",
    ],
    [
      "a root cause without path:line",
      triage.replace("`src/a.ts:12`", "the queue"),
      "names the file and line",
    ],
    ["four alternatives", triage.replace("- a — no", "- a\n- b\n- c\n- d"), "at most three lines"],
    [
      "a triage report over 300 words",
      triage.replace("Keep it.", "word ".repeat(300)),
      "the budget is 300",
    ],
    [
      "a triage report without Fast track",
      triage.replace(/## Fast track\n(?:- .*\n)+/, ""),
      "a triage report has the sections",
    ],
    [
      "a Fast track line missing",
      triage.replace("- Fix tried: yes\n", ""),
      "holds these five lines",
    ],
    [
      "a Fast track no without its reason",
      triage.replace("no — agent-device could carry the fix", "no"),
      "holds these five lines",
    ],
    [
      "a two-line Spec updated",
      `Spec updated: Scope.\nAnd Tests.\n\n${FOOTER}`,
      "one line and the footer",
    ],
    [
      "a review note on two lines",
      `## Review notes\n\nNot blocking.\n\n- spec: src/a.ts:1 x\n  and more\n\n${FOOTER}`,
      "one bullet on one line",
    ],
  ])("refuses a body with %s", (_, body, reason) => {
    const result = bash(`gh issue comment 9 --body-file ${bodyFile(body)}`, null);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it.each([
    ["a handoff", handoff("the maintainer's answer on the timeout")],
    ["a triage report", triage],
    [
      "a triage report whose Fast track reasons take it past 300 words",
      triage
        .replace("Keep it.", "word ".repeat(290))
        .replace("could carry the fix", "word ".repeat(40)),
    ],
    ["a superseding triage report", `Supersedes the report above.\n\n${triage}`],
    ["a Spec updated line", `Spec updated: Scope and Tests.\n\n${FOOTER}`],
    [
      "review notes",
      `## Review notes\n\nNot blocking.\n\n- spec: src/a.ts:1 x\n- code: y\n\n_Written by an agent._`,
    ],
  ])("posts %s in its shape", (_, body) => {
    expect(bash(`gh pr comment 9 --body-file ${bodyFile(body)}`, null)).toEqual(OK);
  });

  it("reads the body from every place gh takes it, and refuses one it cannot read", () => {
    const good = `Done.\n\n${FOOTER}`;
    const file = bodyFile(good);
    const scratch = slashed(join(mkdtempSync(join(tmpdir(), "tool-guard-")), "new.md"));

    expect(bash(`gh issue comment 9 --body "${good}"`, null)).toEqual(OK);
    expect(bash(`gh issue comment 9 --body "$(cat <<'EOF'\n${good}\nEOF\n)"`, null)).toEqual(OK);
    expect(bash(`gh issue comment 9 --body-file - <<'EOF'\n${good}\nEOF`, null)).toEqual(OK);
    expect(
      bash(`cat > ${scratch} <<'EOF'\n${good}\nEOF\ngh pr edit 9 --body-file ${scratch}`, null),
    ).toEqual(OK);
    expect(bash(`gh api -X PATCH repos/o/r/pulls/9 -F body=@${file}`, null)).toEqual(OK);
    expect(bash(`gh issue close 9 --comment "${good}"`, null)).toEqual(OK);
    expect(bash("gh api -X PATCH repos/o/r/pulls/9 -f body=Done.", null).status).toBe(2);
    expect(bash("gh issue edit 9 --body-file /no/such/file.md", null).stderr).toContain(
      "does not exist yet",
    );
    for (const command of [
      'gh issue comment 9 --body "$(git log -1)"',
      'gh issue comment 9 --body "$BODY"',
      "gh issue comment 9 --body `cat x`",
    ]) {
      expect(bash(command, null).stderr).toContain("pass `--body-file <file>`");
    }
  });

  it("reads a body file named through a variable the call sets once, to a literal, before the use", () => {
    const good = `Done.\n\n${FOOTER}`;
    const file = bodyFile(good);
    const scratch = slashed(join(mkdtempSync(join(tmpdir(), "tool-guard-")), "new.md"));

    expect(bash(`F=${file}; gh issue comment 9 --body-file "$F"`, null)).toEqual(OK);
    expect(bash(`export F="${file}"\ngh issue comment 9 --body-file \${F}`, null)).toEqual(OK);
    expect(
      bash(`D=${dirname(file)} && F="$D/body.md" && gh pr edit 9 --body-file "$F"`, null),
    ).toEqual(OK);
    expect(
      bash(`F=${scratch}; cat > "$F" <<'EOF'\n${good}\nEOF\ngh pr edit 9 --body-file "$F"`, null),
    ).toEqual(OK);
    expect(
      bash(`F=${bodyFile("Done.\n")}; gh issue comment 9 --body-file "$F"`, null).stderr,
    ).not.toContain("pass `--body-file <file>`");
  });

  it.each([
    [
      "sets twice",
      (file: string) => `F=/tmp/other.md; F=${file}; gh issue comment 9 --body-file "$F"`,
    ],
    ["sets from a command", () => 'F=$(mktemp); gh issue comment 9 --body-file "$F"'],
    [
      "sets only for the program",
      (file: string) => `F=${file} true; gh issue comment 9 --body-file "$F"`,
    ],
    ["sets after the use", (file: string) => `gh issue comment 9 --body-file "$F"; F=${file}`],
    [
      "sets in a loop",
      (file: string) =>
        `F=${file}; for F in /tmp/other.md; do :; done; gh issue comment 9 --body-file "$F"`,
    ],
    [
      "reads from input",
      (file: string) => `F=${file}; read -r F; gh issue comment 9 --body-file "$F"`,
    ],
    [
      "expands with a default",
      (file: string) => `F=${file}; gh issue comment 9 --body-file "\${F:-x}"`,
    ],
  ])("refuses a body file named through a variable the call %s", (_what, command) => {
    const result = bash(command(bodyFile(`Done.\n\n${FOOTER}`)), null);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pass `--body-file <file>`");
  });
});

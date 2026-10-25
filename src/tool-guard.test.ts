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

function agent(toolInput: object, agentId: string | null = null) {
  return call({ tool_name: "Agent", tool_input: toolInput, ...(agentId && { agent_id: agentId }) });
}

function bodyFile(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "tool-guard-")), "body.md");
  writeFileSync(file, body);
  return file;
}

const OK = { status: 0, stderr: "" };

describe("tool-guard.mjs", () => {
  it.each([
    "pnpm check",
    "pnpm run fallow",
    "pnpm test",
    "pnpm typecheck:e2e",
    "pnpm exec oxfmt src/a.ts",
    "npx -y tsc --noEmit",
    "node_modules/.bin/oxlint src",
    "node .agents/scripts/comment-lint.mjs --base origin/main",
    "pnpm test:e2e",
    "pnpm test:console",
    "sed -i '' 's/a/b/' f.ts && pnpm check 2>&1 | tail -5",
    "timeout 100 pnpm fallow",
    "pnpm tsc --noEmit",
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
    "pnpm exec vitest run --project unit src/a.test.ts",
    "pnpm test:e2e e2e/http-api.test.ts",
    "pnpm test:console --project=chromium e2e/console/leases.spec.ts",
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
    ["pnpm exec vitest run --project unit src/a.test.ts", {}, "timeout: 600000"],
    ["pnpm test:changed", { timeout: 120_000 }, "timeout: 600000"],
    ["ls", { run_in_background: true, timeout: 600_000 }, "background"],
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

  it("refuses a sub-agent's test run without the long timeout", () => {
    const result = bash("pnpm exec vitest run --project unit src/a.test.ts", "a1", "reviewer", {
      timeout: 120000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("timeout: 600000");
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
    'git commit -m "test: never git stash or git rebase (#1)"',
  ])("lets a sub-agent run %s", (command) => {
    expect(bash(command, "a1", "implementer")).toEqual(OK);
  });

  it("lets the main session stash and rebase", () => {
    expect(bash("git stash push -u -m tag && git rebase origin/main", null)).toEqual(OK);
  });

  it("refuses a sub-agent's PR that is not a draft, or comes from a -repro branch, and its gh pr ready", () => {
    const body = bodyFile(`Closes #1\n\n${FOOTER}\n`);
    const repro = mkdtempSync(join(tmpdir(), "tool-guard-repro-"));
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

  it("requires an implementer's brief and a reviewer's protocol in the prompt, from this checkout", () => {
    const build = readFileSync(join(ROOT, ".agents", "briefs", "implement-build.md"), "utf8");
    const fix = readFileSync(join(ROOT, ".agents", "briefs", "implement-fix.md"), "utf8");
    const protocol = readFileSync(join(ROOT, "docs", "internal", "REVIEW.md"), "utf8");
    const implementer = (prompt: string) => agent({ subagent_type: "implementer", prompt });
    const reviewer = (prompt: string) => agent({ subagent_type: "reviewer", prompt });

    expect(implementer(`${LEDGER}\nissue: 966\nmode: build\nbrief:\n${build}`)).toEqual(OK);
    expect(implementer(`${LEDGER}\nissue: 966\nmode: build`).stderr).toContain(
      "`.agents/briefs/implement-build.md`",
    );
    expect(implementer(`${LEDGER}\nissue: 966\nmode: build\nbrief:\n${fix}`).status).toBe(2);
    expect(implementer(`${LEDGER}\nissue: 966\nbrief:\n${build}`).stderr).toContain("`mode:` line");
    expect(reviewer(`${LEDGER}\npr: 975\nprotocol:\n${protocol}`)).toEqual(OK);
    expect(reviewer(`${LEDGER}\npr: 975`).stderr).toContain("carries `protocol:`");
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
    const scratch = join(mkdtempSync(join(tmpdir(), "tool-guard-")), "new.md");

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
});

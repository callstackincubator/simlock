import { spawnSync } from "node:child_process";
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

function bash(
  command: string,
  agentId: string | null = "a1",
  agentType = "reviewer",
  input: Record<string, unknown> = {},
) {
  return call({
    tool_name: "Bash",
    tool_input: { command, ...input },
    ...(agentId && { agent_id: agentId, agent_type: agentType }),
  });
}

// why: a test run is allowed only with the Bash tool's timeout set (the default 120 s moves it to
// the background), so the "lets run" cases pass it the way an agent must.
const TIMEOUT = { timeout: 600_000 };

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
    "node .agents/scripts/test-lint.mjs --base origin/main",
    "pnpm lint:tests",
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
    "pnpm test:console --project=chromium e2e/console/shell.spec.ts",
    'git commit -qm "run pnpm check in CI"',
    'git commit -m "chore(fallow): remove four stale suppressions"',
    'gh pr create --title "chore(fallow): x" --body-file b.md',
    "echo 'a; pnpm check'",
    "sed -i '' 's/oxfmt/oxlint/' docs/a.md",
    "grep -n tsc package.json",
    "python3 - <<'E'\nprint(\"pnpm check\")\nE\ngit status --short",
    "cat > x.sh <<EOF\npnpm check\nEOF\nchmod +x x.sh",
  ])("lets a sub-agent run a test, or a command that only names a check: %s", (command) => {
    expect(bash(command, "a1", "reviewer", TIMEOUT)).toEqual({ status: 0, stderr: "" });
  });

  it.each([
    ["pnpm exec vitest run --project unit src/a.test.ts", {}, "timeout: 600000"],
    ["pnpm test:changed", { timeout: 120_000 }, "timeout: 600000"],
    ["pnpm test:console --project=chromium", TIMEOUT, "Checks agents never run"],
    ["ls", { run_in_background: true }, "background"],
    ["(git push origin x > log 2>&1; echo done) &", {}, "background"],
    ["until ! pgrep -f lefthook >/dev/null; do sleep 5; done; tail x", {}, "loop that sleeps"],
    ["for _ in $(seq 18); do [ -f out ] && break; sleep 30; done", {}, "loop that sleeps"],
    ["cat > /tmp/x 2>/dev/null; mkdir -p .agents/scratch", {}, "no input"],
    ["cat > ../pr-911.md", {}, "no input"],
  ])("refuses a sub-agent's wait or background job: %s", (command, input, reason) => {
    const result = bash(command, "a1", "implementer", input);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it.each([
    ["git add -A && git commit -m x", {}],
    ["ls vitest* ui/vitest.config.ts", {}],
    ["cat vitest.config.ts | head", {}],
    ['for _ in $(seq 18); do [ -f "$log.exit" ] && break; sleep 30; done; cat "$log.exit"', {}],
    ["scripts/slow-e2e.sh e2e/slow-ios.test.ts", {}],
    ["cat > ../pr-911.md <<'EOF'\nCloses #1\nEOF\ngit status", {}],
    ["python3 - <<'EOF'\nfor i in range(3):\n  time.sleep(1)\nEOF", {}],
  ])(
    "lets a sub-agent run a foreground command, the slow lane wait included: %s",
    (command, input) => {
      expect(bash(command, "a1", "implementer", input)).toEqual({ status: 0, stderr: "" });
    },
  );

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
    expect(
      call({ tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt: "x" } }),
    ).toEqual({ status: 0, stderr: "" });
    expect(
      call({
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", isolation: "worktree", prompt: "x" },
      }),
    ).toEqual({ status: 0, stderr: "" });
  });
});

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "manual-hook.mjs",
);

function checkout(label: string): string {
  // why: a command line names a path with "/" on every host, as a shell does.
  const root = mkdtempSync(join(tmpdir(), "manual-hook-repo-")).replaceAll("\\", "/");
  for (const dir of ["src/a/b", "src/c", "ui/src"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Root\n");
  writeFileSync(join(root, "src/a/AGENTS.md"), `# A of ${label}\n`);
  writeFileSync(join(root, "src/a/b/AGENTS.md"), `# B of ${label}\n`);
  writeFileSync(join(root, "ui/AGENTS.md"), `# UI of ${label}\n`);
  return root;
}

function call(state: string, input: object): string {
  const out = spawnSync("node", [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: state, TEMP: state, TMP: state },
  }).stdout;
  return out === "" ? "" : JSON.parse(out).hookSpecificOutput.additionalContext;
}

function bash(state: string, cwd: string, command: string, agent?: string): string {
  return call(state, {
    session_id: "s1",
    ...(agent === undefined ? {} : { agent_id: agent }),
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  });
}

function record(type: "assistant" | "user", content: unknown): string {
  return `${JSON.stringify({ type, message: { role: type, content } })}\n`;
}

describe("manual-hook.mjs", () => {
  it("sends the manual of every folder down to the file a command reads, top one first", () => {
    const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
    const repo = checkout("main");

    const said = bash(state, repo, "sed -n 1,40p src/a/b/index.ts");

    expect(said).toContain("Module manual src/a/AGENTS.md");
    expect(said).toContain("# A of main");
    expect(said.indexOf("# A of main")).toBeLessThan(said.indexOf("# B of main"));
    expect(said).not.toContain("# Root");
  });

  it("sends each manual once per agent, and again to another agent", () => {
    const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
    const repo = checkout("main");

    expect(bash(state, repo, "cat src/a/x.ts", "agent-1")).toContain("# A of main");
    expect(bash(state, repo, "rg -n foo src/a/y.ts", "agent-1")).toBe("");
    expect(bash(state, repo, "rg -n foo src/a/b/z.ts", "agent-1")).toContain("# B of main");
    expect(bash(state, repo, "cat src/a/x.ts", "agent-2")).toContain("# A of main");
  });

  it("reads the manual from the checkout an absolute path or a leading cd names", () => {
    const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
    const repo = checkout("main");
    const worktree = checkout("worktree");

    expect(bash(state, repo, `sed -n 5,9p '${worktree}/src/a/x.ts'`, "agent-1")).toContain(
      "# A of worktree",
    );
    expect(bash(state, repo, `cd ${worktree} && grep -n bar ui/src/app.tsx`, "agent-2")).toContain(
      "# UI of worktree",
    );
  });

  it("reads the path a Grep or Glob call searches", () => {
    const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
    const repo = checkout("main");

    const said = call(state, {
      session_id: "s1",
      cwd: repo,
      tool_name: "Grep",
      tool_input: { pattern: "foo", path: `${repo}/src/a/b` },
    });

    expect(said).toContain("# B of main");
  });

  it("keeps each call under Claude Code's 10,000-character cap: no table padding, a long manual in parts", () => {
    const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
    const repo = checkout("main");
    const rows = Array.from(
      { length: 400 },
      (_, i) => `| \`file-${i}.ts\`      | role ${i}      |`,
    );
    const manual = [
      "# Long",
      "",
      "| File     | Role     |",
      "| -------- | -------- |",
      ...rows,
      "",
    ].join("\n");
    writeFileSync(join(repo, "src/c/AGENTS.md"), manual);

    const first = bash(state, repo, "cat src/c/x.ts");
    const second = bash(state, repo, "git status");
    const third = bash(state, repo, "git status");

    expect(first.length).toBeLessThan(10_000);
    expect(first).toContain("| `file-0.ts` | role 0 |");
    expect(first).toContain("| --- | --- |");
    expect(first).toContain("The rest of this manual comes with your next tool call.");
    expect(second).toContain("Module manual src/c/AGENTS.md, continued");
    expect(second).toContain("| `file-399.ts` | role 399 |");
    expect(`${first}\n${second}`.match(/role \d+ \|/g)).toHaveLength(400);
    expect(third).toBe("");
  });

  it("sends no manual to the reviewer or the hardware verifier, and still sends a lens its manuals", () => {
    const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
    const repo = checkout("main");
    const as = (type: string): string =>
      call(state, {
        session_id: "s1",
        agent_id: `agent-${type}`,
        agent_type: type,
        cwd: repo,
        tool_name: "Bash",
        tool_input: { command: "cat src/a/x.ts" },
      });

    expect(as("code-reviewer")).toContain("# A of main");
    expect(as("reviewer")).toBe("");
    expect(as("hardware-verifier")).toBe("");
  });

  it.each([
    [
      "the Skill tool's call",
      record("assistant", [
        { type: "tool_use", id: "t2", name: "Skill", input: { skill: "deliver" } },
      ]),
    ],
    [
      "the /deliver command",
      record(
        "user",
        "<command-message>deliver</command-message>\n<command-name>/deliver</command-name>",
      ),
    ],
  ])(
    "sends a main session no manual once its transcript holds %s, and its sub-agents still get theirs",
    (_form, started) => {
      const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
      const repo = checkout("main");
      const transcript = join(state, "transcript.jsonl");
      writeFileSync(
        transcript,
        record("assistant", [
          { type: "tool_use", id: "t1", name: "Skill", input: { skill: "spec-session" } },
        ]) +
          record("user", [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "<command-name>/deliver</command-name>",
            },
          ]),
      );
      const reads = (command: string, agent?: object): string =>
        call(state, {
          session_id: "s1",
          transcript_path: transcript,
          cwd: repo,
          tool_name: "Bash",
          tool_input: { command },
          ...agent,
        });

      expect(reads("cat src/a/x.ts")).toContain("# A of main");
      appendFileSync(transcript, started);
      expect(reads("cat src/a/b/y.ts")).toBe("");
      expect(reads("cat ui/src/app.tsx")).toBe("");
      expect(
        reads("cat src/a/b/y.ts", { agent_id: "agent-1", agent_type: "implementer" }),
      ).toContain("# B of main");
    },
  );

  it("says nothing for a folder with no manual, a path outside src/ and ui/, or no session", () => {
    const state = mkdtempSync(join(tmpdir(), "manual-hook-"));
    const repo = checkout("main");

    expect(bash(state, repo, "cat src/c/x.ts docs/internal/ARCHITECTURE.md README.md")).toBe("");
    expect(
      call(state, { cwd: repo, tool_name: "Bash", tool_input: { command: "cat src/a/x.ts" } }),
    ).toBe("");
  });
});

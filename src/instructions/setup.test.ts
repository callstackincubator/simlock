import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MemoryFilesystem,
  NodeFilesystem,
  ProcessSpawnError,
  type ProcessRunner,
} from "../ports/index.js";
import {
  renderSkill,
  SetupMcpFailedError,
  SetupRefusedError,
  setupAgentTools,
  toolRunner,
  type SetupAgentToolsOptions,
  type ToolOutcome,
} from "./index.js";

const HOME = "/home/operator";
const CWD = "/work/project";

interface ToolCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

function fakeTools(outcome: ToolOutcome = { outcome: "exited", code: 0, stderr: "" }): {
  readonly calls: ToolCall[];
  readonly runTool: SetupAgentToolsOptions["runTool"];
} {
  const calls: ToolCall[] = [];
  return {
    calls,
    runTool: async (bin, args, { cwd }) => {
      calls.push({ bin, args, cwd });
      return outcome;
    },
  };
}

function fakeConfirm(yes: readonly string[] = []): {
  readonly questions: string[];
  readonly confirm: (question: string) => Promise<boolean>;
} {
  const questions: string[] = [];
  return {
    questions,
    confirm: async (question) => {
      questions.push(question);
      return yes.includes(question);
    },
  };
}

const SCOPE_PROMPT = "Install only for this project (not every project)? [y/N] ";
const CLAUDE_PROMPT = "Also connect Simlock's MCP server to Claude Code? [y/N] ";
const CODEX_PROMPT =
  "Also connect Simlock's MCP server to Codex? Codex counts it as a second agent beside the CLI. [y/N] ";

function setup(
  filesystem: MemoryFilesystem,
  options: Partial<Omit<SetupAgentToolsOptions, "filesystem">> = {},
): ReturnType<typeof setupAgentTools> {
  return setupAgentTools({
    filesystem,
    homeDirectory: HOME,
    workingDirectory: CWD,
    runTool: fakeTools().runTool,
    confirm: fakeConfirm().confirm,
    interactive: false,
    ...options,
  });
}

async function tree(filesystem: MemoryFilesystem, root: string): Promise<string[]> {
  if (!(await filesystem.exists(root))) return [];
  const paths: string[] = [];
  for (const name of await filesystem.readdir(root)) {
    const path = root === "/" ? `/${name}` : `${root}/${name}`;
    paths.push(path);
    if ((await filesystem.lstat(path)).kind === "directory")
      paths.push(...(await tree(filesystem, path)));
  }
  return paths.sort();
}

async function withBases(): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(HOME);
  await filesystem.mkdirp(CWD);
  return filesystem;
}

describe("setupAgentTools", () => {
  it("writes the skill where each tool reads it for the scope: home for the user scope, the working directory for the project scope", async () => {
    for (const [scope, base, other] of [
      ["user", HOME, CWD],
      ["project", CWD, HOME],
    ] as const) {
      const filesystem = await withBases();
      for (const [tool, skills] of [
        ["claude-code", ".claude/skills"],
        ["codex", ".agents/skills"],
      ] as const) {
        const report = await setup(filesystem, { scope, tool });

        expect(report.scope).toBe(scope);
        expect(report.tools).toEqual([
          { tool, skill: { status: "wrote", path: `${base}/${skills}/simlock` } },
        ]);
        expect(await filesystem.readFile(`${base}/${skills}/simlock/SKILL.md`), tool).toBe(
          renderSkill(),
        );
      }
      expect(await tree(filesystem, other), scope).toEqual([]);
    }
  });

  it("with no tool named, installs the tools set up here and skips the others; a named tool is installed anyway", async () => {
    const claudeOnly = await withBases();
    await claudeOnly.mkdirp(`${HOME}/.claude`);

    expect((await setup(claudeOnly)).tools).toEqual([
      { tool: "claude-code", skill: { status: "wrote", path: `${HOME}/.claude/skills/simlock` } },
      { tool: "codex", skill: { status: "skipped", path: `${HOME}/.agents/skills/simlock` } },
    ]);
    expect(await claudeOnly.exists(`${HOME}/.claude/skills/simlock/SKILL.md`)).toBe(true);
    expect(await claudeOnly.exists(`${HOME}/.agents`)).toBe(false);

    const codexFile = await withBases();
    await codexFile.mkdirp(`${HOME}/.claude`);
    await codexFile.writeFileAtomic(`${HOME}/.codex`, "not a directory");
    const afterFile = await setup(codexFile);
    expect(afterFile.tools.map(({ skill }) => skill.status)).toEqual(["wrote", "skipped"]);
    expect(await codexFile.readFile(`${HOME}/.codex`)).toBe("not a directory");

    const customHome = await withBases();
    await customHome.mkdirp("/custom/codex-home");
    const viaCodexHome = await setup(customHome, { codexHome: "/custom/codex-home" });
    expect(viaCodexHome.tools.map(({ skill }) => skill.status)).toEqual(["skipped", "wrote"]);
    expect(await customHome.exists(`${HOME}/.agents/skills/simlock/SKILL.md`)).toBe(true);

    const projectScope = await withBases();
    await projectScope.mkdirp("/custom/codex-home");
    const atProject = await setup(projectScope, {
      scope: "project",
      codexHome: "/custom/codex-home",
    });
    expect(atProject.tools.map(({ skill }) => skill.status)).toEqual(["skipped", "skipped"]);

    const bare = await withBases();
    const named = await setup(bare, { tool: "codex" });
    expect(named.tools).toEqual([
      { tool: "codex", skill: { status: "wrote", path: `${HOME}/.agents/skills/simlock` } },
    ]);
    expect(await tree(bare, HOME)).toEqual([
      `${HOME}/.agents`,
      `${HOME}/.agents/skills`,
      `${HOME}/.agents/skills/simlock`,
      `${HOME}/.agents/skills/simlock/SKILL.md`,
    ]);
  });

  it("connects MCP through the tool's own command, reports each outcome, and bounds the command at 30 s", async () => {
    const claudeAdd = (scope: string): readonly string[] => [
      "mcp",
      "add",
      "-s",
      scope,
      "simlock",
      "--",
      "simlock",
      "mcp",
    ];
    const codexAdd = ["mcp", "add", "simlock", "--", "simlock", "mcp"];

    for (const [scope, tool, bin, args] of [
      ["user", "claude-code", "claude", claudeAdd("user")],
      ["project", "claude-code", "claude", claudeAdd("project")],
      ["user", "codex", "codex", codexAdd],
    ] as const) {
      const tools = fakeTools();
      const report = await setup(await withBases(), {
        scope,
        tool,
        mcp: true,
        runTool: tools.runTool,
      });
      expect(tools.calls, `${scope} ${tool}`).toEqual([{ bin, args, cwd: CWD }]);
      expect(report.tools[0]?.mcp, `${scope} ${tool}`).toEqual({ status: "connected" });
    }

    const long = `${"x".repeat(250)}\nsecond line`;
    for (const [tool, outcome, mcp] of [
      [
        "claude-code",
        {
          outcome: "exited",
          code: 1,
          stderr: "MCP server simlock already exists in user config\n",
        },
        { status: "already" },
      ],
      [
        "codex",
        {
          outcome: "exited",
          code: 1,
          stderr: "MCP server simlock already exists in user config\n",
        },
        { status: "failed", reason: "MCP server simlock already exists in user config" },
      ],
      [
        "claude-code",
        { outcome: "exited", code: 1, stderr: "boom: no config\nmore detail\n" },
        { status: "failed", reason: "boom: no config" },
      ],
      [
        "claude-code",
        { outcome: "exited", code: 1, stderr: long },
        { status: "failed", reason: "x".repeat(200) },
      ],
      [
        "claude-code",
        { outcome: "timed-out" },
        { status: "failed", reason: "timed out after 30 s" },
      ],
      ["claude-code", { outcome: "not-found" }, { status: "skipped", reason: "claude not found" }],
      ["codex", { outcome: "not-found" }, { status: "skipped", reason: "codex not found" }],
    ] as const) {
      const run = setup(await withBases(), {
        tool,
        mcp: true,
        runTool: fakeTools(outcome).runTool,
      });
      const label = `${tool} ${JSON.stringify(outcome)}`;
      if (mcp.status === "failed") {
        const error = (await run.catch((caught: unknown) => caught)) as SetupMcpFailedError;
        expect(error, label).toBeInstanceOf(SetupMcpFailedError);
        expect(error.message, label).toBe(`MCP not connected for ${tool}: ${mcp.reason}`);
        expect(error.report.tools[0]?.mcp, label).toEqual(mcp);
        expect(error.report.tools[0]?.skill.status, label).toBe("wrote");
      } else {
        expect((await run).tools[0]?.mcp, label).toEqual(mcp);
      }
    }

    const both = await withBases();
    await both.mkdirp(`${HOME}/.claude`);
    await both.mkdirp(`${HOME}/.codex`);
    const failing = fakeTools({ outcome: "exited", code: 1, stderr: "nope" });
    const error = (await setup(both, { mcp: true, runTool: failing.runTool }).catch(
      (caught: unknown) => caught,
    )) as SetupMcpFailedError;
    expect(error.message).toBe(
      "MCP not connected for claude-code: nope; MCP not connected for codex: nope",
    );

    const projectCodex = fakeTools();
    const skipped = await setup(await withBases(), {
      scope: "project",
      tool: "codex",
      mcp: true,
      runTool: projectCodex.runTool,
    });
    expect(skipped.tools[0]?.mcp).toEqual({
      status: "skipped",
      reason: "codex mcp add has no project scope",
    });

    const unrequested = fakeTools();
    const notAsked = await setup(await withBases(), {
      tool: "claude-code",
      mcp: false,
      runTool: unrequested.runTool,
    });
    expect(notAsked.tools[0]).not.toHaveProperty("mcp");
    const notInstalled = await withBases();
    await notInstalled.mkdirp(`${HOME}/.claude`);
    const skippedSkill = await setup(notInstalled, { mcp: true, runTool: unrequested.runTool });
    expect(skippedSkill.tools[1]).toEqual({
      tool: "codex",
      skill: { status: "skipped", path: `${HOME}/.agents/skills/simlock` },
    });
    expect(unrequested.calls.map(({ bin }) => bin)).toEqual(["claude"]);
    expect(projectCodex.calls).toEqual([]);

    const seen: { command: string; args: readonly string[]; options: unknown }[] = [];
    const runner = (
      behave: () => Promise<{ code: number | null; stderr: string }>,
    ): ProcessRunner =>
      ({
        run: async (command: string, args: readonly string[], options: unknown) => {
          seen.push({ command, args, options });
          return { stdout: "", ...(await behave()) };
        },
        spawn: () => {
          throw new Error("unused");
        },
        spawnStreaming: () => {
          throw new Error("unused");
        },
      }) as ProcessRunner;

    const missing = toolRunner(
      runner(async () => {
        throw new ProcessSpawnError("claude", ["mcp"]);
      }),
    );
    expect(await missing("claude", ["mcp"], { cwd: CWD })).toEqual({ outcome: "not-found" });
    const killed = toolRunner(runner(async () => ({ code: null, stderr: "" })));
    expect(await killed("claude", [], { cwd: CWD })).toEqual({ outcome: "timed-out" });
    const exited = toolRunner(runner(async () => ({ code: 1, stderr: "bad" })));
    expect(await exited("claude", ["a"], { cwd: "/somewhere" })).toEqual({
      outcome: "exited",
      code: 1,
      stderr: "bad",
    });
    expect(seen.at(-1)).toEqual({
      command: "claude",
      args: ["a"],
      options: { timeoutMs: 30_000, cwd: "/somewhere" },
    });
  });

  it("asks in a terminal and never blocks a script: the scope, then MCP per tool", async () => {
    const both = async (): Promise<MemoryFilesystem> => {
      const filesystem = await withBases();
      for (const base of [HOME, CWD]) {
        await filesystem.mkdirp(`${base}/.claude`);
        await filesystem.mkdirp(`${base}/.codex`);
      }
      return filesystem;
    };

    const yesToScope = fakeConfirm([SCOPE_PROMPT]);
    const project = await setup(await both(), { interactive: true, confirm: yesToScope.confirm });
    expect(project.scope).toBe("project");
    expect(yesToScope.questions).toEqual([SCOPE_PROMPT, CLAUDE_PROMPT]);

    const defaults = fakeConfirm();
    const tools = fakeTools();
    const user = await setup(await both(), {
      interactive: true,
      confirm: defaults.confirm,
      runTool: tools.runTool,
    });
    expect(user.scope).toBe("user");
    expect(defaults.questions).toEqual([SCOPE_PROMPT, CLAUDE_PROMPT, CODEX_PROMPT]);
    expect(user.tools.map((entry) => "mcp" in entry)).toEqual([false, false]);
    expect(tools.calls).toEqual([]);

    for (const scope of ["user", "project"] as const) {
      const flagged = fakeConfirm();
      await setup(await both(), { scope, interactive: true, confirm: flagged.confirm });
      expect(flagged.questions, scope).not.toContain(SCOPE_PROMPT);
    }

    const mcpYes = fakeConfirm([CLAUDE_PROMPT, CODEX_PROMPT]);
    const asked = fakeTools();
    const connected = await setup(await both(), {
      interactive: true,
      confirm: mcpYes.confirm,
      runTool: asked.runTool,
    });
    expect(connected.tools.map(({ mcp }) => mcp?.status)).toEqual(["connected", "connected"]);
    expect(asked.calls.map(({ bin }) => bin)).toEqual(["claude", "codex"]);

    const noMcpAsked = fakeConfirm();
    await setup(await both(), { mcp: false, interactive: true, confirm: noMcpAsked.confirm });
    expect(noMcpAsked.questions).toEqual([SCOPE_PROMPT]);

    const script = fakeConfirm([SCOPE_PROMPT, CLAUDE_PROMPT]);
    const scripted = fakeTools();
    const quiet = await setup(await both(), {
      interactive: false,
      confirm: script.confirm,
      runTool: scripted.runTool,
    });
    expect(script.questions).toEqual([]);
    expect(quiet.scope).toBe("user");
    expect(quiet.tools.map((entry) => "mcp" in entry)).toEqual([false, false]);
    expect(scripted.calls).toEqual([]);

    const projectAsk = fakeConfirm([CLAUDE_PROMPT, CODEX_PROMPT]);
    const atProject = await setup(await both(), {
      scope: "project",
      interactive: true,
      confirm: projectAsk.confirm,
    });
    expect(projectAsk.questions).toEqual([CLAUDE_PROMPT]);
    expect(atProject.tools.map(({ mcp }) => mcp?.status)).toEqual(["connected", undefined]);
  });

  it("a second run replaces only its own files: same bytes, stale entries gone, a SKILL.md directory turned into the file", async () => {
    const filesystem = await withBases();
    await filesystem.mkdirp(`${HOME}/.claude`);
    await filesystem.mkdirp(`${HOME}/.codex`);
    await setup(filesystem);
    const first = await tree(filesystem, HOME);

    const second = await setup(filesystem);

    expect(second.tools.map(({ skill }) => skill.status)).toEqual(["replaced", "replaced"]);
    expect(await tree(filesystem, HOME)).toEqual(first);

    await filesystem.mkdirp(`${HOME}/.claude/skills/simlock/old`);
    await filesystem.writeFileAtomic(`${HOME}/.claude/skills/simlock/old/notes.md`, "stale");
    await filesystem.writeFileAtomic(`${HOME}/.claude/skills/simlock/SKILL.md`, "old rules");
    await filesystem.writeFileAtomic(`${HOME}/.claude/skills/other.md`, "not ours");
    await setup(filesystem, { tool: "claude-code" });
    expect(await tree(filesystem, `${HOME}/.claude/skills`)).toEqual([
      `${HOME}/.claude/skills/other.md`,
      `${HOME}/.claude/skills/simlock`,
      `${HOME}/.claude/skills/simlock/SKILL.md`,
    ]);
    expect(await filesystem.readFile(`${HOME}/.claude/skills/simlock/SKILL.md`)).toBe(
      renderSkill(),
    );
    expect(await filesystem.readFile(`${HOME}/.claude/skills/other.md`)).toBe("not ours");

    // why: a rename onto a directory fails on the real filesystem, and the in-memory double
    // would let it through.
    const root = await mkdtemp(join(tmpdir(), "simlock-setup-"));
    try {
      const simlock = join(root, ".agents/skills/simlock");
      await mkdir(join(simlock, "SKILL.md/nested"), { recursive: true });
      const report = await setupAgentTools({
        filesystem: new NodeFilesystem(),
        homeDirectory: root,
        workingDirectory: CWD,
        scope: "user",
        tool: "codex",
        runTool: fakeTools().runTool,
        confirm: fakeConfirm().confirm,
        interactive: false,
      });
      expect(report.tools.map(({ skill }) => skill.status)).toEqual(["replaced"]);
      expect(await readdir(simlock)).toEqual(["SKILL.md"]);
      expect(await readFile(join(simlock, "SKILL.md"), "utf8")).toBe(renderSkill());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a file or a symlink where the skill directory goes, and writes nothing for any tool", async () => {
    for (const [kind, place] of [
      [
        "file",
        (filesystem: MemoryFilesystem, path: string) => filesystem.writeFileAtomic(path, "mine"),
      ],
      [
        "symlink",
        async (filesystem: MemoryFilesystem, path: string) => {
          await filesystem.mkdirp("/elsewhere");
          filesystem.defineSymlink(path, "/elsewhere");
        },
      ],
    ] as const) {
      const filesystem = await withBases();
      await filesystem.mkdirp(`${HOME}/.claude`);
      await filesystem.mkdirp(`${HOME}/.codex`);
      await filesystem.mkdirp(`${HOME}/.agents/skills`);
      // why: codex comes second, so a refusal that only stopped at the bad tool would already
      // have written claude-code's skill.
      await place(filesystem, `${HOME}/.agents/skills/simlock`);
      const before = await tree(filesystem, "/");
      const tools = fakeTools();

      const error = (await setup(filesystem, { mcp: true, runTool: tools.runTool }).catch(
        (caught: unknown) => caught,
      )) as SetupRefusedError;

      expect(error, kind).toBeInstanceOf(SetupRefusedError);
      expect(error.message, kind).toBe(
        `Refusing to install: ${HOME}/.agents/skills/simlock exists and is not a directory. Nothing was written. Move it aside and run setup again.`,
      );
      expect(await tree(filesystem, "/"), kind).toEqual(before);
      expect(tools.calls, kind).toEqual([]);
    }
  });
});

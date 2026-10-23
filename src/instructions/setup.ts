import { join } from "node:path";

import { ProcessSpawnError, type Filesystem, type ProcessRunner } from "../ports/index.js";
import { renderSkill } from "./skill.js";

const AGENT_TOOLS = {
  "claude-code": { presence: ".claude", skills: ".claude/skills" },
  codex: { presence: ".codex", skills: ".agents/skills" },
} as const;

export type AgentTool = keyof typeof AGENT_TOOLS;
export type SetupScope = "user" | "project";

const SIMLOCK_DIRECTORY = "simlock";
const SKILL_FILE = "SKILL.md";

export interface SetupToolReport {
  readonly tool: AgentTool;
  readonly mcp?: {
    readonly status: "connected" | "already" | "failed" | "skipped";
    readonly reason?: string;
  };
  readonly skill: {
    readonly status: "wrote" | "replaced" | "skipped";
    readonly path: string;
  };
}

export type ToolOutcome =
  | { readonly outcome: "exited"; readonly code: number; readonly stderr: string }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "timed-out" };

export type RunTool = (
  bin: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<ToolOutcome>;

const TOOL_TIMEOUT_MS = 30_000;
const MAX_REASON_LENGTH = 200;

export function toolRunner(runner: ProcessRunner): RunTool {
  return async (bin, args, { cwd }) => {
    try {
      const result = await runner.run(bin, args, { timeoutMs: TOOL_TIMEOUT_MS, cwd });
      if (result.code === null) return { outcome: "timed-out" };
      return { outcome: "exited", code: result.code, stderr: result.stderr };
    } catch (error: unknown) {
      if (error instanceof ProcessSpawnError) return { outcome: "not-found" };
      throw error;
    }
  };
}

export class SetupMcpFailedError extends Error {
  constructor(readonly report: SetupReport) {
    super(
      report.tools
        .filter(({ mcp }) => mcp?.status === "failed")
        .map(({ tool, mcp }) => `MCP not connected for ${tool}: ${mcp?.reason}`)
        .join("; "),
    );
    this.name = "SetupMcpFailedError";
  }
}

export interface SetupReport {
  readonly scope: SetupScope;
  readonly tools: readonly SetupToolReport[];
}

export interface SetupAgentToolsOptions {
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  readonly scope: SetupScope;
  readonly runTool: RunTool;
  readonly mcp?: boolean | undefined;
  readonly codexHome?: string | undefined;
  readonly tool?: AgentTool | undefined;
}

export const AGENT_TOOL_IDS = Object.keys(AGENT_TOOLS) as readonly AgentTool[];

export async function setupAgentTools(options: SetupAgentToolsOptions): Promise<SetupReport> {
  const { filesystem, scope, tool } = options;
  const base = scope === "user" ? options.homeDirectory : options.workingDirectory;
  const tools = tool === undefined ? AGENT_TOOL_IDS : [tool];

  const report: SetupToolReport[] = [];
  for (const id of tools) {
    const layout = AGENT_TOOLS[id];
    const path = join(base, layout.skills, SIMLOCK_DIRECTORY);
    const presence =
      id === "codex" && scope === "user" && options.codexHome !== undefined
        ? options.codexHome
        : join(base, layout.presence);
    const install = tool !== undefined || (await isDirectory(filesystem, presence));
    report.push({ tool: id, skill: { status: install ? "wrote" : "skipped", path } });
  }

  const skill = renderSkill();
  for (const { skill: entry } of report) {
    if (entry.status === "skipped") continue;
    await filesystem.mkdirp(entry.path);
    await filesystem.writeFileAtomic(join(entry.path, SKILL_FILE), skill);
  }
  const connected: SetupToolReport[] = [];
  for (const entry of report) {
    const mcp =
      options.mcp === true && entry.skill.status !== "skipped"
        ? await connectMcp(options.runTool, entry.tool, scope, options.workingDirectory)
        : undefined;
    connected.push(mcp === undefined ? entry : { ...entry, mcp });
  }
  const result: SetupReport = { scope, tools: connected };
  if (connected.some(({ mcp }) => mcp?.status === "failed")) throw new SetupMcpFailedError(result);
  return result;
}

type McpResult = NonNullable<SetupToolReport["mcp"]>;

async function connectMcp(
  runTool: RunTool,
  tool: AgentTool,
  scope: SetupScope,
  cwd: string,
): Promise<McpResult> {
  if (tool === "codex" && scope === "project") {
    return { status: "skipped", reason: "codex mcp add has no project scope" };
  }
  const bin = tool === "claude-code" ? "claude" : "codex";
  const args =
    tool === "claude-code"
      ? ["mcp", "add", "-s", scope, "simlock", "--", "simlock", "mcp"]
      : ["mcp", "add", "simlock", "--", "simlock", "mcp"];
  const outcome = await runTool(bin, args, { cwd });
  if (outcome.outcome === "not-found") return { status: "skipped", reason: `${bin} not found` };
  if (outcome.outcome === "timed-out") {
    return { status: "failed", reason: "timed out after 30 s" };
  }
  if (outcome.code === 0) return { status: "connected" };
  if (tool === "claude-code" && outcome.stderr.includes("already exists in")) {
    return { status: "already" };
  }
  return { status: "failed", reason: firstLine(outcome.stderr) };
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, MAX_REASON_LENGTH);
}

async function isDirectory(filesystem: Filesystem, path: string): Promise<boolean> {
  if (!(await filesystem.exists(path))) return false;
  return (await filesystem.stat(path)).kind === "directory";
}

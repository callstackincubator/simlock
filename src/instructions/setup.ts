import { join } from "node:path";

import {
  isMissingPathError,
  ProcessSpawnError,
  type Filesystem,
  type PathDetails,
  type ProcessRunner,
} from "../ports/index.js";
import { renderSkill } from "./skill.js";

const AGENT_TOOLS = {
  "claude-code": {
    name: "Claude Code",
    bin: "claude",
    presence: ".claude",
    skills: ".claude/skills",
  },
  codex: { name: "Codex", bin: "codex", presence: ".codex", skills: ".agents/skills" },
} as const;

export type AgentTool = keyof typeof AGENT_TOOLS;
export type SetupScope = "user" | "project";

const SCOPE_PROMPT = "Install only for this project (not every project)? [y/N] ";
const MCP_PROMPTS: Readonly<Record<AgentTool, string>> = {
  "claude-code": "Also connect Simlock's MCP server to Claude Code? [y/N] ",
  codex:
    "Also connect Simlock's MCP server to Codex? Codex counts it as a second agent beside the CLI. [y/N] ",
};
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

export class SetupRefusedError extends Error {
  constructor(readonly path: string) {
    super(
      `Refusing to install: ${path} exists and is not a directory. Nothing was written. Move it aside and run setup again.`,
    );
    this.name = "SetupRefusedError";
  }
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
  readonly scope?: SetupScope | undefined;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly interactive: boolean;
  readonly runTool: RunTool;
  readonly mcp?: boolean | undefined;
  readonly codexHome?: string | undefined;
  readonly tool?: AgentTool | undefined;
}

export const AGENT_TOOL_IDS = Object.keys(AGENT_TOOLS) as readonly AgentTool[];

export function agentToolName(tool: AgentTool): string {
  return AGENT_TOOLS[tool].name;
}

export async function setupAgentTools(options: SetupAgentToolsOptions): Promise<SetupReport> {
  const scope =
    options.scope ??
    (options.interactive && (await options.confirm(SCOPE_PROMPT)) ? "project" : "user");
  const report = await inspectTools(options, scope);
  const wantsMcp = await askMcp(options, scope, report);

  const skill = renderSkill();
  for (const { skill: entry } of report) {
    if (entry.status !== "skipped") await installSkill(options.filesystem, entry.path, skill);
  }
  const tools: SetupToolReport[] = [];
  for (const entry of report) {
    const mcp = wantsMcp.has(entry.tool)
      ? await connectMcp(options.runTool, entry.tool, scope, options.workingDirectory)
      : undefined;
    tools.push(mcp === undefined ? entry : { ...entry, mcp });
  }
  const result: SetupReport = { scope, tools };
  if (tools.some(({ mcp }) => mcp?.status === "failed")) throw new SetupMcpFailedError(result);
  return result;
}

async function inspectTools(
  options: SetupAgentToolsOptions,
  scope: SetupScope,
): Promise<SetupToolReport[]> {
  const { filesystem, tool } = options;
  const base = scope === "user" ? options.homeDirectory : options.workingDirectory;
  const report: SetupToolReport[] = [];
  for (const id of tool === undefined ? AGENT_TOOL_IDS : [tool]) {
    const layout = AGENT_TOOLS[id];
    const path = join(base, layout.skills, SIMLOCK_DIRECTORY);
    const presence =
      id === "codex" && scope === "user" && options.codexHome !== undefined
        ? options.codexHome
        : join(base, layout.presence);
    const install = tool !== undefined || (await isDirectory(filesystem, presence));
    const status = install ? await installStatus(filesystem, path) : "skipped";
    report.push({ tool: id, skill: { status, path } });
  }
  return report;
}

async function askMcp(
  options: SetupAgentToolsOptions,
  scope: SetupScope,
  report: readonly SetupToolReport[],
): Promise<Set<AgentTool>> {
  const wantsMcp = new Set<AgentTool>();
  for (const { tool, skill } of report) {
    if (skill.status !== "skipped" && (await wantsMcpFor(options, scope, tool))) {
      wantsMcp.add(tool);
    }
  }
  return wantsMcp;
}

async function wantsMcpFor(
  options: SetupAgentToolsOptions,
  scope: SetupScope,
  tool: AgentTool,
): Promise<boolean> {
  if (options.mcp !== undefined) return options.mcp;
  if (!options.interactive || (tool === "codex" && scope === "project")) return false;
  return options.confirm(MCP_PROMPTS[tool]);
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
  const { bin } = AGENT_TOOLS[tool];
  const args =
    tool === "claude-code"
      ? ["mcp", "add", "-s", scope, "simlock", "--", "simlock", "mcp"]
      : ["mcp", "add", "simlock", "--", "simlock", "mcp"];
  return mcpResult(tool, bin, await runTool(bin, args, { cwd }));
}

function mcpResult(tool: AgentTool, bin: string, outcome: ToolOutcome): McpResult {
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

async function installSkill(
  filesystem: Filesystem,
  directory: string,
  skill: string,
): Promise<void> {
  await filesystem.mkdirp(directory);
  const skillPath = join(directory, SKILL_FILE);
  if ((await lstatKind(filesystem, skillPath)) !== "file") await filesystem.rm(skillPath);
  await filesystem.writeFileAtomic(skillPath, skill);
  for (const name of await filesystem.readdir(directory)) {
    if (name !== SKILL_FILE) await filesystem.rm(join(directory, name));
  }
}

async function lstatKind(
  filesystem: Filesystem,
  path: string,
): Promise<PathDetails["kind"] | undefined> {
  try {
    return (await filesystem.lstat(path)).kind;
  } catch (error: unknown) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function installStatus(filesystem: Filesystem, path: string): Promise<"wrote" | "replaced"> {
  const kind = await lstatKind(filesystem, path);
  if (kind === undefined) return "wrote";
  if (kind !== "directory") throw new SetupRefusedError(path);
  return "replaced";
}

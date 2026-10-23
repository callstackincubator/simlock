import { join } from "node:path";

import type { Filesystem, ProcessRunner } from "../ports/index.js";
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

export function toolRunner(_runner: ProcessRunner): RunTool {
  return async () => ({ outcome: "not-found" });
}

export class SetupMcpFailedError extends Error {
  constructor(readonly report: SetupReport) {
    super("");
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
  return { scope, tools: report };
}

async function isDirectory(filesystem: Filesystem, path: string): Promise<boolean> {
  if (!(await filesystem.exists(path))) return false;
  return (await filesystem.stat(path)).kind === "directory";
}

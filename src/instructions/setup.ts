import { join } from "node:path";

import type { Filesystem } from "../ports/index.js";
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
  readonly skill: {
    readonly status: "wrote" | "replaced" | "skipped";
    readonly path: string;
  };
}

export interface SetupReport {
  readonly scope: SetupScope;
  readonly tools: readonly SetupToolReport[];
}

export interface SetupAgentToolsOptions {
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  readonly tool: AgentTool;
}

export async function setupAgentTools(options: SetupAgentToolsOptions): Promise<SetupReport> {
  const { filesystem, tool } = options;
  const directory = join(options.homeDirectory, AGENT_TOOLS[tool].skills, SIMLOCK_DIRECTORY);
  await filesystem.mkdirp(directory);
  await filesystem.writeFileAtomic(join(directory, SKILL_FILE), renderSkill());
  return { scope: "user", tools: [{ tool, skill: { status: "wrote", path: directory } }] };
}

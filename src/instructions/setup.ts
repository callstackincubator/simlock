import { join } from "node:path";

import { isMissingPathError, type Filesystem } from "../ports/filesystem.js";
import { renderSkill } from "./index.js";

/**
 * The agent tools `simlock setup` installs the rules into, and the one place that knows where
 * each keeps its skills. `presence` is the directory whose existence says the tool is set up
 * there; `skills` is where the tool looks for skills. Both are relative to the scope's base:
 * the home directory for the user scope, the working directory for the project scope.
 */
const AGENT_TOOLS = {
  "claude-code": { presence: ".claude", skills: ".claude/skills" },
  codex: { presence: ".codex", skills: ".codex/skills" },
} as const;

export type AgentTool = keyof typeof AGENT_TOOLS;
export type SetupScope = "user" | "project";

export const AGENT_TOOL_IDS = Object.keys(AGENT_TOOLS) as readonly AgentTool[];

/** Simlock's whole footprint in a tool: one directory it owns outright, holding one file. */
const SIMLOCK_DIRECTORY = "simlock";
const SKILL_FILE = "SKILL.md";

export interface SetupToolReport {
  readonly tool: AgentTool;
  readonly status: "wrote" | "replaced" | "skipped";
  /** The Simlock directory: where the skill was written, or would have been for a skipped tool. */
  readonly path: string;
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
  /** Install for this tool whether or not it is set up there. Omitted: every tool that is. */
  readonly tool?: AgentTool | undefined;
}

/** Something other than a directory sits where a Simlock directory belongs. Nothing was written. */
export class SetupRefusedError extends Error {
  constructor(readonly path: string) {
    super(
      `Refusing to install: ${path} exists and is not a directory. Nothing was written. Move it aside and run setup again.`,
    );
    this.name = "SetupRefusedError";
  }
}

export function isAgentTool(value: string): value is AgentTool {
  return Object.hasOwn(AGENT_TOOLS, value);
}

/**
 * Installs the agent rules as a skill into each selected tool. Inspects every tool before
 * writing any, so a refusal leaves every tool exactly as it found it (architecture rule 12).
 * Writes nothing outside `<skills>/simlock`, and within it leaves only `SKILL.md`.
 */
export async function setupAgentTools(options: SetupAgentToolsOptions): Promise<SetupReport> {
  const { filesystem, scope, tool } = options;
  const base = scope === "user" ? options.homeDirectory : options.workingDirectory;
  const tools = tool === undefined ? AGENT_TOOL_IDS : [tool];

  const plan: { tool: AgentTool; path: string; install: boolean; existed: boolean }[] = [];
  for (const id of tools) {
    const layout = AGENT_TOOLS[id];
    const path = join(base, layout.skills, SIMLOCK_DIRECTORY);
    const install = tool !== undefined || (await filesystem.exists(join(base, layout.presence)));
    const existed = install && (await isExistingDirectory(filesystem, path));
    plan.push({ tool: id, path, install, existed });
  }

  const skill = renderSkill();
  const report: SetupToolReport[] = [];
  for (const entry of plan) {
    if (!entry.install) {
      report.push({ tool: entry.tool, status: "skipped", path: entry.path });
      continue;
    }
    await filesystem.mkdirp(entry.path);
    await filesystem.writeFileAtomic(join(entry.path, SKILL_FILE), skill);
    for (const name of await filesystem.readdir(entry.path)) {
      if (name !== SKILL_FILE) await filesystem.rm(join(entry.path, name));
    }
    report.push({
      tool: entry.tool,
      status: entry.existed ? "replaced" : "wrote",
      path: entry.path,
    });
  }
  return { scope, tools: report };
}

/**
 * Whether a Simlock directory is already there, read without following a symlink. A file, a
 * symlink, or anything else at that path refuses the run: the directory is Simlock's to replace
 * whole, and a symlink would point that replacement somewhere Simlock does not own.
 */
async function isExistingDirectory(filesystem: Filesystem, path: string): Promise<boolean> {
  let kind;
  try {
    ({ kind } = await filesystem.lstat(path));
  } catch (error: unknown) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  if (kind !== "directory") throw new SetupRefusedError(path);
  return true;
}

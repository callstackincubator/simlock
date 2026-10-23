import {
  SetupMcpFailedError,
  setupAgentTools,
  type AgentTool,
  type SetupReport,
} from "../../instructions/index.js";
import { commandArgs, UsageError } from "../args.js";
import type { CommandContext } from "../tree.js";

const USAGE =
  "Usage: simlock setup [--user | --project] [--tool <claude-code|codex>] [--mcp | --no-mcp] [--json]\n";
const TOOLS: readonly string[] = ["claude-code", "codex"];
const TOOL_ID_WIDTH = 11;
const SKILL_STATUS_WIDTH = 9;
const TOOL_NAMES: Readonly<Record<AgentTool, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function renderReport(report: SetupReport): string {
  const lines: string[] = [];
  for (const { tool, skill, mcp } of report.tools) {
    const label = tool.padEnd(TOOL_ID_WIDTH);
    const skipped =
      skill.status === "skipped"
        ? `  (${TOOL_NAMES[tool]} not found here; pass --tool ${tool} to install anyway)`
        : "";
    lines.push(
      `${label}  skill  ${skill.status.padEnd(SKILL_STATUS_WIDTH)}  ${skill.path}${skipped}`,
    );
    if (mcp !== undefined) {
      const reason = mcp.reason === undefined ? "" : `  (${mcp.reason})`;
      lines.push(`${label}  mcp    ${mcp.status}${reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function run(argv: readonly string[], { environment }: CommandContext): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    user: { type: "boolean" },
    project: { type: "boolean" },
    tool: { type: "string", multiple: true },
    mcp: { type: "boolean" },
    "no-mcp": { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write(USAGE);
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("setup accepts no arguments");
  if (values.user && values.project)
    throw new UsageError("--user and --project cannot be used together");
  if (values.mcp && values["no-mcp"])
    throw new UsageError("--mcp and --no-mcp cannot be used together");
  const tools = values.tool as string[] | undefined;
  if (tools !== undefined && tools.length > 1) throw new UsageError("--tool can be given once");
  const tool = tools?.[0];
  if (tool !== undefined && !TOOLS.includes(tool)) {
    throw new UsageError(`--tool takes ${TOOLS.join(" or ")}`);
  }
  const json = values.json === true;
  const print = (report: SetupReport): void => {
    environment.stdout.write(json ? `${JSON.stringify(report)}\n` : renderReport(report));
  };
  try {
    print(
      await setupAgentTools({
        filesystem: environment.filesystem,
        homeDirectory: environment.homeDirectory,
        workingDirectory: environment.workingDirectory,
        codexHome: environment.codexHome,
        scope: values.project ? "project" : values.user ? "user" : undefined,
        mcp: values.mcp ? true : values["no-mcp"] ? false : undefined,
        tool: tool as AgentTool | undefined,
        runTool: environment.runTool,
        confirm: environment.confirm ?? (async () => false),
        interactive: !json,
      }),
    );
  } catch (error: unknown) {
    if (error instanceof SetupMcpFailedError) print(error.report);
    throw error;
  }
  return 0;
}

export { run };

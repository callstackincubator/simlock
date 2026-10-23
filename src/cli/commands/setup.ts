import {
  AGENT_TOOL_IDS,
  agentToolName,
  SetupMcpFailedError,
  setupAgentTools,
  type AgentTool,
  type SetupReport,
} from "../../instructions/index.js";
import { commandArgs, UsageError } from "../args.js";
import type { CommandContext } from "../tree.js";

const USAGE =
  "Usage: simlock setup [--user | --project] [--tool <claude-code|codex>] [--mcp | --no-mcp] [--json]\n";
const TOOLS: readonly string[] = AGENT_TOOL_IDS;
const TOOL_ID_WIDTH = 11;
const SKILL_STATUS_WIDTH = 9;

function renderReport(report: SetupReport): string {
  const lines: string[] = [];
  for (const { tool, skill, mcp } of report.tools) {
    const label = tool.padEnd(TOOL_ID_WIDTH);
    const skipped =
      skill.status === "skipped"
        ? `  (${agentToolName(tool)} not found here; pass --tool ${tool} to install anyway)`
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

interface SetupFlags {
  readonly help: boolean;
  readonly json: boolean;
  readonly scope: "user" | "project" | undefined;
  readonly mcp: boolean | undefined;
  readonly tool: AgentTool | undefined;
}

function exclusive(first: unknown, second: unknown, message: string): void {
  if (first === true && second === true) throw new UsageError(message);
}

function parseTool(tools: readonly string[]): AgentTool | undefined {
  if (tools.length > 1) throw new UsageError("--tool can be given once");
  const tool = tools[0];
  if (tool !== undefined && !TOOLS.includes(tool)) {
    throw new UsageError(`--tool takes ${TOOLS.join(" or ")}`);
  }
  return tool as AgentTool | undefined;
}

function parseSetupFlags(argv: readonly string[]): SetupFlags {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    user: { type: "boolean" },
    project: { type: "boolean" },
    tool: { type: "string", multiple: true },
    mcp: { type: "boolean" },
    "no-mcp": { type: "boolean" },
  });
  if (values.positionals.length > 0) throw new UsageError("setup accepts no arguments");
  exclusive(values.user, values.project, "--user and --project cannot be used together");
  exclusive(values.mcp, values["no-mcp"], "--mcp and --no-mcp cannot be used together");
  return {
    help: values.help === true,
    json: values.json === true,
    scope: values.project ? "project" : values.user ? "user" : undefined,
    mcp: values.mcp ? true : values["no-mcp"] ? false : undefined,
    tool: parseTool((values.tool ?? []) as string[]),
  };
}

async function run(argv: readonly string[], { environment }: CommandContext): Promise<number> {
  const flags = parseSetupFlags(argv);
  if (flags.help) {
    environment.stdout.write(USAGE);
    return 0;
  }
  const print = (report: SetupReport): void => {
    environment.stdout.write(flags.json ? `${JSON.stringify(report)}\n` : renderReport(report));
  };
  try {
    print(
      await setupAgentTools({
        filesystem: environment.filesystem,
        homeDirectory: environment.homeDirectory,
        workingDirectory: environment.workingDirectory,
        codexHome: environment.codexHome,
        scope: flags.scope,
        mcp: flags.mcp,
        tool: flags.tool,
        runTool: environment.runTool,
        confirm: environment.confirm ?? (async () => false),
        interactive: !flags.json,
      }),
    );
  } catch (error: unknown) {
    if (error instanceof SetupMcpFailedError) print(error.report);
    throw error;
  }
  return 0;
}

export { run };

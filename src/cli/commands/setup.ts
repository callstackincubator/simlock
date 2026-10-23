import { setupAgentTools, type AgentTool } from "../../instructions/index.js";
import { commandArgs } from "../args.js";
import type { CommandContext } from "../tree.js";

async function run(argv: readonly string[], { environment }: CommandContext): Promise<number> {
  const values = commandArgs(argv, { tool: { type: "string" } });
  await setupAgentTools({
    filesystem: environment.filesystem,
    homeDirectory: environment.homeDirectory,
    workingDirectory: "",
    scope: "user",
    tool: values.tool as AgentTool,
  });
  return 0;
}

export { run };

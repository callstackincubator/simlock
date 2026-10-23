import { setupAgentTools, type AgentTool } from "../../instructions/index.js";
import { commandArgs } from "../args.js";
import type { CommandContext } from "../tree.js";

async function run(argv: readonly string[], { environment }: CommandContext): Promise<number> {
  const values = commandArgs(argv, { project: { type: "boolean" }, tool: { type: "string" } });
  await setupAgentTools({
    filesystem: environment.filesystem,
    homeDirectory: environment.homeDirectory,
    workingDirectory: environment.workingDirectory,
    codexHome: environment.codexHome,
    runTool: environment.runTool,
    scope: values.project === true ? "project" : "user",
    confirm: async () => false,
    interactive: false,
    tool: values.tool as AgentTool | undefined,
  });
  return 0;
}

export { run };

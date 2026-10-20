// why: the MCP server and its SDK are the heaviest thing the CLI can run, so they load only
// here, and only once the flags are through.
import { UsageError } from "../errors.js";
import { isHelp } from "../args.js";
import type { CommandContext } from "../tree.js";
import type { McpStdioLauncher } from "../types.js";

async function loadDefaultMcpStdio(): Promise<McpStdioLauncher> {
  return (await import("../../mcp/main.js")).runMcpStdio;
}

async function run(
  argv: readonly string[],
  { environment, gateway }: CommandContext,
): Promise<number> {
  if (argv.length === 1 && isHelp(argv[0])) {
    environment.stdout.write("Usage: simlock mcp\n");
    return 0;
  }
  if (argv.length > 0) throw new UsageError("mcp accepts no arguments");
  const runMcpStdio =
    environment.runMcpStdio ?? (await (environment.loadMcpStdio ?? loadDefaultMcpStdio)());
  await runMcpStdio({ gateway });
  return 0;
}

export { run };

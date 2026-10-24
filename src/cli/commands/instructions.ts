import { renderInstructions } from "../../instructions/index.js";
import { commandArgs, UsageError } from "../args.js";
import type { CommandContext } from "../tree.js";

async function run(argv: readonly string[], { environment }: CommandContext): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock instructions [--json]\n");
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("instructions accepts no arguments");
  const text = renderInstructions(values.json ? "json" : "text");
  environment.stdout.write(values.json ? `${text}\n` : text);
  return 0;
}

export { run };

import { connectDaemonClient } from "../connect.js";
import { commandArgs, writeResult } from "../args.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    rule: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock cleanup [--dry-run] [--rule <name>]\n");
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      (value) => environment.stdout.write(value),
      await client.runCleanup({
        dryRun: values["dry-run"] === true,
        ...(typeof values.rule === "string" ? { rule: values.rule } : {}),
      }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

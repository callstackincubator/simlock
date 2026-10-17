import { connectDaemonClient } from "../connect.js";
import { commandArgs, writeResult } from "../args.js";
import { formatStatus } from "../format.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock status [--json]\n");
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const status = await client.getStatus();
    if (values.json) writeResult((value) => environment.stdout.write(value), status);
    else environment.stdout.write(`${formatStatus(status, environment.clock.now())}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

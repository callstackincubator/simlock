import { connectDaemonClient } from "../connect.js";
import { commandArgs, writeResult } from "../args.js";
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
    environment.stdout.write("Usage: simlock whoami [--json]\n");
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const identity = await client.identity();
    if (values.json) writeResult((value) => environment.stdout.write(value), identity);
    else {
      environment.stdout.write(
        `Principal: ${identity.principal}\nName:      ${identity.name}\nRole:      ${identity.role}\nVia:       ${identity.via}\n`,
      );
    }
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

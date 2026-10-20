import {
  commandArgs,
  requiredPositional,
  subcommandOrUsage,
  UsageError,
  withHelpHint,
  writeResult,
} from "../args.js";
import { connectDaemonClient } from "../connect.js";
import type { CommandContext } from "../tree.js";

const ALERTS_USAGE = "Usage: simlock alerts test <destination> [--json]\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsed = subcommandOrUsage(argv, context.path, environment.stdout, ALERTS_USAGE);
  if (parsed === 0) return 0;
  if (parsed.command !== "test") {
    throw new UsageError(withHelpHint(`Unknown alerts command: ${parsed.command}`));
  }
  const values = commandArgs(parsed.flagArgs, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write(ALERTS_USAGE);
    return 0;
  }
  const destination = requiredPositional(values.positionals, "destination");
  const client = await connectDaemonClient(environment, token);
  try {
    const result = await client.testAlertDestination({ destination });
    if (values.json) writeResult((value) => environment.stdout.write(value), result);
    else
      environment.stdout.write(
        `Sent a test message to ${result.destination}: HTTP ${result.status}\n`,
      );
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

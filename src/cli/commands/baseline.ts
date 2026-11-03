import { commandArgs, subcommandOrUsage, UsageError, withHelpHint } from "../args.js";
import { connectDaemonClient } from "../connect.js";
import { baselineSavedLine } from "../format.js";
import type { CommandContext } from "../tree.js";

const BASELINE_USAGE =
  "Usage: simlock baseline save <name> --lease <id> [--note <text>]\n" +
  "       simlock baseline list [--json]\n" +
  "       simlock baseline remove <name> [--yes]\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsed = subcommandOrUsage(argv, context.path, environment.stdout, BASELINE_USAGE);
  if (parsed === 0) return 0;
  if (parsed.command !== "save") {
    throw new UsageError(withHelpHint(`Unknown baseline command: ${String(parsed.command)}`));
  }
  return runSave(parsed.flagArgs, environment, token);
}

async function runSave(
  argv: readonly string[],
  environment: CommandContext["environment"],
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    lease: { type: "string" },
    note: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(BASELINE_USAGE);
    return 0;
  }
  const [name, ...extra] = values.positionals;
  if (name === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("baseline save takes one <name>"));
  }
  const leaseId = values.lease;
  if (typeof leaseId !== "string" || leaseId === "") {
    throw new UsageError(withHelpHint("baseline save requires --lease <id>"));
  }
  const note = typeof values.note === "string" ? values.note : undefined;
  const client = await connectDaemonClient(environment, token);
  try {
    const saved = await client.saveBaseline({
      leaseId,
      name,
      ...(note === undefined ? {} : { note }),
    });
    environment.stdout.write(baselineSavedLine(saved));
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

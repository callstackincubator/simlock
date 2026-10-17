import type { SimlockAdminClient } from "../../admin/index.js";
import { connectDaemonClient } from "../connect.js";
import {
  commandArgs,
  requiredPositional,
  subcommandOrUsage,
  UsageError,
  withHelpHint,
  writeResult,
} from "../args.js";
import { formatWorkers } from "../format.js";
import type { CommandContext } from "../tree.js";

const WORKER_USAGE =
  "Usage: simlock worker list [--json]\n" +
  "       simlock worker drain <worker-id>\n" +
  "       simlock worker undrain <worker-id>\n" +
  "       simlock worker remove <worker-id>\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsedSubcommand = subcommandOrUsage(argv, context.path, environment.stdout, WORKER_USAGE);
  if (parsedSubcommand === 0) return 0;
  const { command, flagArgs } = parsedSubcommand;
  const client = await connectDaemonClient(environment, token);
  try {
    if (command === "list") return await runWorkerList(flagArgs, client, environment);
    if (command === "drain" || command === "undrain" || command === "remove") {
      return await runWorkerAction(command, flagArgs, client, environment);
    }
    throw new UsageError(withHelpHint(`Unknown worker command: ${String(command)}`));
  } finally {
    await client.close();
  }
}

async function runWorkerList(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock worker list [--json]\n");
    return 0;
  }
  const result = await client.listWorkers();
  if (values.json) writeResult((value) => environment.stdout.write(value), result);
  else
    environment.stdout.write(
      `${formatWorkers(result.workers, { installs: true, now: environment.clock.now() })}\n`,
    );
  return 0;
}

async function runWorkerAction(
  command: "drain" | "undrain" | "remove",
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
): Promise<number> {
  const values = commandArgs(argv, { help: { type: "boolean", short: "h" } });
  if (values.help) {
    environment.stdout.write(`Usage: simlock worker ${command} <worker-id>\n`);
    return 0;
  }
  const workerId = requiredPositional(values.positionals, "worker-id");
  const result =
    command === "drain"
      ? await client.drainWorker({ workerId })
      : command === "undrain"
        ? await client.undrainWorker({ workerId })
        : await client.removeWorker({ workerId });
  writeResult((value) => environment.stdout.write(value), result);
  return 0;
}

export { run };

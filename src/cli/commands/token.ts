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
import type { CommandContext } from "../tree.js";

const TOKEN_USAGE =
  "Usage: simlock token create --role <agent|operator|worker> [--label <text>]\n" +
  "       simlock token list\n" +
  "       simlock token revoke <token-id>\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsedSubcommand = subcommandOrUsage(argv, context.path, environment.stdout, TOKEN_USAGE);
  if (parsedSubcommand === 0) return 0;
  const { command, flagArgs } = parsedSubcommand;
  const client = await connectDaemonClient(environment, token);
  try {
    if (command === "create") return await runTokenCreate(flagArgs, client, environment);
    if (command === "list") return await runTokenList(flagArgs, client, environment);
    if (command === "revoke") return await runTokenRevoke(flagArgs, client, environment);
    throw new UsageError(withHelpHint(`Unknown token command: ${String(command)}`));
  } finally {
    await client.close();
  }
}

async function runTokenCreate(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    label: { type: "string" },
    role: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock token create --role <agent|operator|worker> [--label <text>]\n",
    );
    return 0;
  }
  const role = parseTokenRole(values.role);
  const label = typeof values.label === "string" ? values.label : undefined;
  if (label === "") throw new UsageError("token create --label must not be empty");
  writeResult(
    (value) => environment.stdout.write(value),
    await client.createToken({ role, ...(label === undefined ? {} : { label }) }),
  );
  return 0;
}

async function runTokenList(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
): Promise<number> {
  const values = commandArgs(argv, { help: { type: "boolean", short: "h" } });
  if (values.help) {
    environment.stdout.write("Usage: simlock token list\n");
    return 0;
  }
  writeResult((value) => environment.stdout.write(value), await client.listTokens());
  return 0;
}

async function runTokenRevoke(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
): Promise<number> {
  const values = commandArgs(argv, { help: { type: "boolean", short: "h" } });
  if (values.help) {
    environment.stdout.write("Usage: simlock token revoke <token-id>\n");
    return 0;
  }
  const id = requiredPositional(values.positionals, "token-id");
  writeResult((value) => environment.stdout.write(value), await client.revokeToken({ id }));
  return 0;
}

function parseTokenRole(value: unknown): "agent" | "operator" | "worker" {
  if (value !== "agent" && value !== "operator" && value !== "worker")
    throw new UsageError(withHelpHint("token create requires --role <agent|operator|worker>"));
  return value;
}

export { run };

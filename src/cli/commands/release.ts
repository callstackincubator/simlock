import { connectDaemonClient } from "../connect.js";
import { commandArgs, requiredPositional, UsageError, writeResult } from "../args.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    all: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean" },
  });
  const { positionals } = values;
  if (values.help) {
    environment.stdout.write("Usage: simlock release <lease-id> | --all [--yes]\n");
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    if (values.all) {
      if (positionals.length > 0)
        throw new UsageError("release accepts either a lease id or --all, not both");
      const confirmed = values.yes ?? (await environment.confirm?.("Release every lease? [y/N] "));
      if (!confirmed) throw new UsageError("release --all requires confirmation or --yes");
      writeResult((value) => environment.stdout.write(value), await client.releaseAllLeases());
      return 0;
    }
    writeResult(
      (value) => environment.stdout.write(value),
      await client.releaseLease({ leaseId: requiredPositional(positionals, "lease-id") }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

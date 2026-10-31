import { parseOrientation } from "../../contract/index.js";
import { commandArgs, requiredPositional, UsageError } from "../args.js";
import { connectDaemonClient } from "../connect.js";
import { resolveRemoteLeaseId } from "../remote-lease.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const { positionals } = commandArgs(argv, {});
  const parsed = parseOrientation(requiredPositional(positionals, "orientation"));
  if (!parsed.ok) throw new UsageError(parsed.message);
  const client = await connectDaemonClient(environment, token);
  try {
    const leaseId = await resolveRemoteLeaseId(client, environment);
    const requesterId = client.role === "admin" ? environment.requesterId : undefined;
    const rotated = await client.rotate(
      leaseId,
      parsed.orientation,
      requesterId === undefined ? undefined : { requesterId },
    );
    environment.stdout.write(`Rotated lease ${rotated.leaseId} to ${rotated.orientation}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

import type { SimlockAdminClient } from "../../admin/index.js";
import { asUsageIfRefused, UsageError } from "../errors.js";
import { resolveRemoteLeaseId } from "../remote-lease.js";
import { connectDaemonClient } from "../connect.js";
import type { CommandContext } from "../tree.js";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const tool = context.path[0] === "adb" ? "adb" : "simctl";
  return runPassthrough(tool, argv, context);
}

async function runPassthrough(
  tool: "simctl" | "adb",
  args: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const { leaseFlag, rest } = extractLeaseFlag(args);
  const client = await connectDaemonClient(environment, token);
  let daemon;
  try {
    ({ daemon } = await client.getStatus());
  } catch (error: unknown) {
    await client.close();
    throw error;
  }
  if (daemon.mode === "gateway") {
    try {
      return await runRemotePassthrough(tool, rest, environment, client, leaseFlag);
    } finally {
      await client.close();
    }
  }
  const run = environment.runPassthrough;
  if (run === undefined) {
    await client.close();
    throw new Error("Tool passthrough is unavailable");
  }
  let command;
  try {
    command = await client.resolvePassthrough({ args: [...rest], tool });
  } catch (error: unknown) {
    throw await asUsageIfRefused(error);
  } finally {
    await client.close();
  }
  return run(command);
}

async function runRemotePassthrough(
  tool: "simctl" | "adb",
  args: readonly string[],
  environment: CommandContext["environment"],
  client: SimlockAdminClient,
  leaseFlag: string | undefined,
): Promise<number> {
  try {
    const leaseId = leaseFlag ?? (await resolveRemoteLeaseId(client, environment));
    const stdin = await environment.readStdin?.();
    const requesterId = client.role === "admin" ? environment.requesterId : undefined;
    const { exitCode } = await client.exec(
      {
        args: [...args],
        leaseId,
        tool,
        ...(requesterId === undefined ? {} : { requesterId }),
        ...(stdin === undefined ? {} : { stdin }),
      },
      {
        onOutput: (chunk) => {
          const sink = chunk.stream === "stdout" ? environment.stdout : environment.stderr;
          sink.write(chunk.chunk);
        },
      },
    );
    return exitCode;
  } catch (error: unknown) {
    throw await asUsageIfRefused(error);
  }
}

function extractLeaseFlag(args: readonly string[]): {
  readonly leaseFlag: string | undefined;
  readonly rest: readonly string[];
} {
  let leaseFlag: string | undefined;
  let index = 0;
  while (index < args.length) {
    const argument = args[index] as string;
    if (argument === "--lease") {
      const value = args[index + 1];
      if (value === undefined) throw new UsageError("--lease requires a lease id");
      leaseFlag = value;
      index += 2;
      continue;
    }
    if (argument.startsWith("--lease=")) {
      leaseFlag = argument.slice("--lease=".length);
      if (leaseFlag === "") throw new UsageError("--lease requires a lease id");
      index += 1;
      continue;
    }
    break;
  }
  return { leaseFlag, rest: args.slice(index) };
}

export { run };

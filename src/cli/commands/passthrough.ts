import { resolve } from "node:path";

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
  const { leaseFlag, sendStdin, rest } = extractLeadingFlags(args);
  const client = await connectDaemonClient(environment, token);
  let viaExec: boolean;
  try {
    // why: a farm's worker owns no device on this machine either, so a remote command is `device.exec` whatever mode the farm answers.
    viaExec =
      environment.remote !== undefined || (await client.getStatus()).daemon.mode === "gateway";
  } catch (error: unknown) {
    await client.close();
    throw error;
  }
  if (viaExec) {
    try {
      return await runRemotePassthrough(tool, rest, environment, client, leaseFlag, sendStdin);
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
  sendStdin: boolean,
): Promise<number> {
  try {
    const leaseId = leaseFlag ?? (await resolveRemoteLeaseId(client, environment));
    const stdin = sendStdin ? await environment.readStdin?.() : "";
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
    await hintAtLocalPath(args, exitCode, environment);
    return exitCode;
  } catch (error: unknown) {
    throw await asUsageIfRefused(error);
  }
}

// why: a command that failed after naming a path that exists here most likely meant a file on its worker's disk, which that path is not; one hint for the first such argument says so.
async function hintAtLocalPath(
  args: readonly string[],
  exitCode: number,
  environment: CommandContext["environment"],
): Promise<void> {
  if (exitCode === 0 || environment.remote === undefined) return;
  for (const argument of args) {
    const kind = await environment.filesystem
      .stat(resolve(environment.workingDirectory, argument))
      .then((found) => found.kind)
      .catch(() => undefined);
    if (kind === undefined) continue;
    const notice =
      kind === "directory"
        ? `${argument} is a folder on this machine, and the command ran on the worker; a folder cannot be uploaded yet (#1636): install it with agent-device, or from a path on the worker`
        : `${argument} is on this machine, but the command ran on the worker; upload it with \`simlock files put ${argument}\` and name it by its file name`;
    environment.stderr.write(`${JSON.stringify({ notice })}\n`);
    return;
  }
}

function extractLeadingFlags(args: readonly string[]): {
  readonly leaseFlag: string | undefined;
  readonly sendStdin: boolean;
  readonly rest: readonly string[];
} {
  let leaseFlag: string | undefined;
  let sendStdin = false;
  let index = 0;
  while (index < args.length) {
    const argument = args[index] as string;
    if (argument === "--stdin") {
      sendStdin = true;
      index += 1;
      continue;
    }
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
  return { leaseFlag, sendStdin, rest: args.slice(index) };
}

export { run };

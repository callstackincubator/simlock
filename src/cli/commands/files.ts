import { basename, resolve } from "node:path";

import {
  commandArgs,
  requiredPositional,
  subcommandOrUsage,
  UsageError,
  withHelpHint,
} from "../args.js";
import { connectDaemonClient, farmEndpoint } from "../connect.js";
import { resolveRemoteLeaseId } from "../remote-lease.js";
import type { CommandContext } from "../tree.js";

const FILES_USAGE = "Usage: simlock files put <file> [--name <name>] [--lease <id>]\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment } = context;
  const parsed = subcommandOrUsage(argv, context.path, environment.stdout, FILES_USAGE);
  if (parsed === 0) return 0;
  if (parsed.command !== "put") {
    throw new UsageError(withHelpHint(`Unknown files command: ${String(parsed.command)}`));
  }
  return runPut(parsed.flagArgs, context);
}

// why: the lease's folder is on its worker, so on the daemon's own machine it is a local folder and there is nothing to move over HTTP.
async function farmOf(environment: CommandContext["environment"]) {
  if (environment.remote === undefined) {
    throw new UsageError(
      "simlock files needs --url or SIMLOCK_URL: on the daemon's machine the lease's folder is a local folder",
    );
  }
  return farmEndpoint(environment.remote);
}

async function localFile(environment: CommandContext["environment"], path: string) {
  const absolute = resolve(environment.workingDirectory, path);
  let kind: "file" | "directory";
  try {
    kind = (await environment.filesystem.stat(absolute)).kind;
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") throw new UsageError(`No file ${path}`);
    throw error;
  }
  if (kind === "directory") {
    throw new UsageError(`${path} is a folder; a folder cannot be uploaded yet (#1636)`);
  }
  return absolute;
}

async function leaseOf(context: CommandContext, flag: string | undefined): Promise<string> {
  if (typeof flag === "string") return flag;
  const client = await connectDaemonClient(context.environment, context.token);
  try {
    return await resolveRemoteLeaseId(client, context.environment);
  } finally {
    await client.close();
  }
}

async function runPut(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment } = context;
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    lease: { type: "string" },
    name: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(FILES_USAGE);
    return 0;
  }
  const path = requiredPositional(values.positionals, "a file to upload");
  const name = typeof values.name === "string" ? values.name : basename(path);
  const farm = await farmOf(environment);
  const absolute = await localFile(environment, path);
  const leaseId = await leaseOf(context, values.lease as string | undefined);
  const { token, url } = farm;
  const file = await environment.filesystem.openFile(absolute);
  try {
    const answered = await environment.httpStream.request({
      body: file.read(),
      contentLength: file.size,
      method: "PUT",
      signal: new AbortController().signal,
      token,
      url: `${url}/v1/leases/${encodeURIComponent(leaseId)}/files/${encodeURIComponent(name)}`,
    });
    const reply = JSON.parse(await new Response(answered.body).text()) as {
      name: string;
      size: number;
    };
    environment.stdout.write(
      `${JSON.stringify({ lease: leaseId, name: reply.name, size: reply.size })}\n`,
    );
    return 0;
  } finally {
    await file.close();
  }
}

export { run };

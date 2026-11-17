import { basename, resolve } from "node:path";

import {
  commandArgs,
  requiredPositional,
  subcommandOrUsage,
  UsageError,
  withHelpHint,
} from "../args.js";
import { connectDaemonClient, farmEndpoint } from "../connect.js";
import { ERROR_TABLE, isSimlockError, SimlockError } from "../../contract/index.js";
import type { HttpStreamAnswer, HttpStreamRequest, TimerHandle } from "../../ports/index.js";
import { resolveRemoteLeaseId } from "../remote-lease.js";
import type { CommandContext } from "../tree.js";

const SILENCE_LIMIT_MS = 60_000;

type Environment = CommandContext["environment"];

const FILES_USAGE =
  "Usage: simlock files put <file> [--name <name>] [--lease <id>]\n" +
  "       simlock files get <name> [-o <file>] [--lease <id>]\n" +
  "       simlock files list [--lease <id>]\n" +
  "       simlock files rm <name> [--lease <id>]\n";

interface Folder {
  readonly origin: string;
  readonly leaseId: string;
  readonly token: string;
  /** why: the folder's route without the file name, so a call appends `/<name>` or nothing. */
  readonly route: string;
}

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment } = context;
  const parsed = subcommandOrUsage(argv, context.path, environment.stdout, FILES_USAGE);
  if (parsed === 0) return 0;
  const { command, flagArgs } = parsed;
  if (command === "put") return runPut(flagArgs, context);
  if (command === "get") return runGet(flagArgs, context);
  if (command === "list") return runList(flagArgs, context);
  if (command === "rm") return runRemove(flagArgs, context);
  throw new UsageError(withHelpHint(`Unknown files command: ${String(command)}`));
}

// why: the lease's folder is on its worker, so on the daemon's own machine it is a local folder and there is nothing to move over HTTP.
async function farmOf(environment: Environment) {
  if (environment.remote === undefined) {
    throw new UsageError(
      "simlock files needs --url or SIMLOCK_URL: on the daemon's machine the lease's folder is a local folder",
    );
  }
  return farmEndpoint(environment.remote);
}

async function folderOf(context: CommandContext, flag: unknown): Promise<Folder> {
  const { environment } = context;
  const { token, url } = await farmOf(environment);
  let leaseId: string;
  if (typeof flag === "string") leaseId = flag;
  else {
    const client = await connectDaemonClient(environment, context.token);
    try {
      leaseId = await resolveRemoteLeaseId(client, environment);
    } finally {
      await client.close();
    }
  }
  return {
    leaseId,
    origin: url,
    route: `${url}/v1/leases/${encodeURIComponent(leaseId)}/files`,
    token,
  };
}

function unreachable(origin: string, reason: string): SimlockError<"REMOTE_UNREACHABLE"> {
  return new SimlockError("REMOTE_UNREACHABLE", "transport", reason, { url: origin });
}

// why: a route answers `{ error: { code, message } }` with the code `ERROR_TABLE` knows, so the command fails with that code and its exit code; any other refusal is the farm not answering as a worker does.
async function refusal(answered: HttpStreamAnswer, origin: string): Promise<Error> {
  let error: { code?: unknown; message?: unknown } | undefined;
  try {
    error = (JSON.parse(await new Response(answered.body).text()) as { error?: typeof error })
      .error;
  } catch {
    error = undefined;
  }
  if (
    typeof error?.code === "string" &&
    typeof error.message === "string" &&
    error.code in ERROR_TABLE
  ) {
    const code = error.code as keyof typeof ERROR_TABLE;
    return new SimlockError(code, ERROR_TABLE[code].kind, error.message, {} as never);
  }
  return unreachable(origin, `The farm at ${origin} answered ${String(answered.status)}`);
}

// why: a transfer has no total time limit: it ends after 60 s in which no byte moved either way, so every piece of either body that passes through `watch` starts the 60 s again.
interface Transfer {
  readonly signal: AbortSignal;
  watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}

// why: one call to a route: its answer must be a success, whatever it carried otherwise.
async function send(
  environment: Environment,
  folder: Folder,
  active: Transfer,
  request: Omit<HttpStreamRequest, "signal" | "token">,
): Promise<HttpStreamAnswer> {
  const answered = await environment.httpStream.request({
    ...request,
    ...(request.body === undefined ? {} : { body: active.watch(request.body) }),
    signal: active.signal,
    token: folder.token,
  });
  if (answered.status < 200 || answered.status > 299) throw await refusal(answered, folder.origin);
  return { ...answered, body: active.watch(answered.body) };
}

// why: a failure of this machine's disk (no folder, no permission, no room, a file in the way) is not the farm failing to answer, and the user must read what their disk said.
const LOCAL_FILE_ERRORS = new Set([
  "EACCES",
  "EDQUOT",
  "EEXIST",
  "EISDIR",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

function isLocalFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && LOCAL_FILE_ERRORS.has(code);
}

// why: an error that is not a route's answer (a refused connection, a body cut on the way, a silence) is the farm not answering.
async function transfer<T>(
  environment: Environment,
  folder: Folder,
  work: (active: Transfer) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let silent = false;
  let timer: TimerHandle | undefined;
  const restart = (): void => {
    if (timer !== undefined) environment.clock.cancel(timer);
    timer = environment.clock.setTimer(SILENCE_LIMIT_MS, () => {
      silent = true;
      controller.abort();
    });
  };
  restart();
  const watch = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> =>
    body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(piece, output) {
          restart();
          output.enqueue(piece);
        },
      }),
    );
  try {
    return await work({ signal: controller.signal, watch });
  } catch (error: unknown) {
    if (isSimlockError(error) || isLocalFileError(error)) throw error;
    throw unreachable(
      folder.origin,
      silent
        ? `No byte moved for ${String(SILENCE_LIMIT_MS / 1000)} s with ${folder.origin}`
        : `No answer from ${folder.origin}`,
    );
  } finally {
    if (timer !== undefined) environment.clock.cancel(timer);
    controller.abort();
  }
}

async function localFile(environment: Environment, path: string): Promise<string> {
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

function filesArgs(argv: readonly string[], environment: Environment, extra: object = {}) {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    lease: { type: "string" },
    ...extra,
  });
  if (values.help) environment.stdout.write(FILES_USAGE);
  return values;
}

function fileRoute(folder: Folder, name: string): string {
  return `${folder.route}/${encodeURIComponent(name)}`;
}

async function runPut(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment } = context;
  const values = filesArgs(argv, environment, { name: { type: "string" } });
  if (values.help) return 0;
  const path = requiredPositional(values.positionals, "a file to upload");
  const name = typeof values.name === "string" ? values.name : basename(path);
  await farmOf(environment);
  const absolute = await localFile(environment, path);
  const folder = await folderOf(context, values.lease);
  const file = await environment.filesystem.openFile(absolute);
  try {
    return await transfer(environment, folder, async (active) => {
      const answered = await send(environment, folder, active, {
        body: file.read(),
        contentLength: file.size,
        method: "PUT",
        url: fileRoute(folder, name),
      });
      const reply = JSON.parse(await new Response(answered.body).text()) as {
        name: string;
        size: number;
      };
      environment.stdout.write(
        `${JSON.stringify({ lease: folder.leaseId, name: reply.name, size: reply.size })}\n`,
      );
      return 0;
    });
  } finally {
    await file.close();
  }
}

async function runGet(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment } = context;
  const values = filesArgs(argv, environment, { output: { type: "string", short: "o" } });
  if (values.help) return 0;
  const name = requiredPositional(values.positionals, "a file name");
  const folder = await folderOf(context, values.lease);
  return transfer(environment, folder, async (active) => {
    const answered = await send(environment, folder, active, {
      method: "GET",
      url: fileRoute(folder, name),
    });
    if (typeof values.output === "string") {
      const target = resolve(environment.workingDirectory, values.output);
      // why: the bytes land beside the target and move into place whole, so a download that fails never leaves a part of the file under its name.
      const partial = `${target}.part`;
      try {
        await environment.filesystem.writeFileStream(partial, answered.body);
      } catch (error: unknown) {
        // why: `wx` fails on a `.part` another run left; that file is not this run's to delete.
        if ((error as { code?: unknown }).code !== "EEXIST") {
          await environment.filesystem.rm(partial).catch(() => undefined);
        }
        throw error;
      }
      try {
        await environment.filesystem.rename(partial, target);
      } catch (error: unknown) {
        // why: the write finished, so this run owns the `.part`; a target that cannot take it (a folder) must not block the next run.
        await environment.filesystem.rm(partial).catch(() => undefined);
        throw error;
      }
      return 0;
    }
    const reader = answered.body.getReader();
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      environment.stdoutBytes(step.value);
    }
    return 0;
  });
}

async function runList(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment } = context;
  const values = filesArgs(argv, environment);
  if (values.help) return 0;
  const folder = await folderOf(context, values.lease);
  return transfer(environment, folder, async (active) => {
    const answered = await send(environment, folder, active, { method: "GET", url: folder.route });
    const listed = JSON.parse(await new Response(answered.body).text()) as unknown;
    environment.stdout.write(`${JSON.stringify(listed)}\n`);
    return 0;
  });
}

async function runRemove(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment } = context;
  const values = filesArgs(argv, environment);
  if (values.help) return 0;
  const name = requiredPositional(values.positionals, "a file name");
  const folder = await folderOf(context, values.lease);
  return transfer(environment, folder, async (active) => {
    await send(environment, folder, active, { method: "DELETE", url: fileRoute(folder, name) });
    return 0;
  });
}

export { run };

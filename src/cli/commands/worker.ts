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
  "       simlock worker remove <worker-id>\n" +
  "       simlock worker update <worker-id> [--version <version>] [--force] [--detach]\n";

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
    if (command === "update") return await runWorkerUpdate(flagArgs, client, environment);
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

const FOLLOW_POLL_MS = 2_000;

type WorkerView = Awaited<ReturnType<SimlockAdminClient["listWorkers"]>>["workers"][number];

function workerName(view: WorkerView | undefined, workerId: string): string {
  return view?.label === undefined ? workerId : `${view.label} (${workerId})`;
}

// why: the follow ends on the worker's own view: its version is the target with no update running, or its last failure names the target.
function followOutcome(
  view: WorkerView | undefined,
  to: string,
  name: string,
): { readonly code: number; readonly text: string } | undefined {
  const failure = view?.lastUpdateFailure;
  if (failure?.to === to) {
    return { code: 1, text: `Update failed (${failure.stage}): ${failure.message}` };
  }
  if (view?.version === to && view.update == null) {
    return { code: 0, text: `${name} is running ${to}` };
  }
  return undefined;
}

function updateEnds(answer: Awaited<ReturnType<SimlockAdminClient["updateWorker"]>>): {
  readonly from: string;
  readonly to: string;
} {
  return {
    from: answer.version,
    to: answer.update?.to ?? answer.resolved ?? "",
  };
}

async function runWorkerUpdate(
  argv: readonly string[],
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
): Promise<number> {
  const values = commandArgs(argv, {
    detach: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock worker update <worker-id> [--version <version>] [--force] [--detach]\n",
    );
    return 0;
  }
  const workerId = requiredPositional(values.positionals, "worker-id");
  const answer = await client.updateWorker({
    workerId,
    ...(typeof values.version === "string" ? { version: values.version } : {}),
    ...(values.force === true ? { force: true } : {}),
  });
  const find = async (): Promise<WorkerView | undefined> =>
    (await client.listWorkers()).workers.find((worker) => worker.id === workerId);
  const first = await find();
  const name = workerName(first, workerId);
  if (answer.upToDate) {
    environment.stdout.write(
      `${upToDateMessage(name, answer, typeof values.version === "string" ? values.version : undefined)}\n`,
    );
    return 0;
  }
  const { from, to } = updateEnds(answer);
  if (values.detach === true) {
    environment.stdout.write(
      `Updating ${name} ${from} → ${to}. Follow it with simlock worker list.\n`,
    );
    return 0;
  }
  return follow({ environment, find, first, name, to });
}

// why: the three reasons a worker is up to date, as `simlock update` tells them apart (update.ts upToDateMessage).
function upToDateMessage(
  name: string,
  answer: { readonly version: string; readonly resolved?: string | null },
  requested: string | undefined,
): string {
  if (requested !== undefined) return `${name} is already running ${answer.version}`;
  if (answer.resolved === answer.version) {
    return `${name} is already on the latest (${answer.version})`;
  }
  return `${name} is newer than the latest (${answer.resolved}). Use --version to install another version.`;
}

async function follow(options: {
  readonly environment: CommandContext["environment"];
  readonly find: () => Promise<WorkerView | undefined>;
  readonly first: WorkerView | undefined;
  readonly name: string;
  readonly to: string;
}): Promise<number> {
  const { environment, find, name, to } = options;
  for (let view = options.first; ; view = await find()) {
    const outcome = followOutcome(view, to, name);
    if (outcome !== undefined) {
      environment.stdout.write(`${outcome.text}\n`);
      return outcome.code;
    }
    await environment.sleep(FOLLOW_POLL_MS);
  }
}

export { run };

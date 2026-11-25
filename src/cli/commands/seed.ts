import type { SeedMakeOutput, SeedProgressUpdate } from "../../admin/index.js";
import { commandArgs, isHelp, UsageError, withHelpHint, writeResult } from "../args.js";
import { connectDaemonClient } from "../connect.js";
import { escapeControl } from "../escape.js";
import { waitForTermination } from "../termination.js";
import type { CommandContext } from "../tree.js";

const SEED_USAGE =
  "Usage: simlock seed <ios|android> <model> [--os <version|range>] [--image-tag <tag>] [--json]\n";

const STAGE_WORDS = {
  making: "making the seed…",
  "settle-running": "waiting behind another settle…",
  "memory-pressure": "waiting: memory pressure…",
  // why: the threshold is the daemon's `diskPressure.freeBytesThreshold`, which the command does not read: it holds no decision.
  "disk-pressure": "waiting: free disk below the threshold…",
  capacity: "waiting: no room for another device…",
  settling: "settling…",
} as const;

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    "image-tag": { type: "string" },
    json: { type: "boolean" },
    os: { type: "string" },
  });
  if (values.help || isHelp(values.positionals[0])) {
    environment.stdout.write(SEED_USAGE);
    return 0;
  }
  const [platform, model, ...extra] = values.positionals;
  if (platform !== "ios" && platform !== "android") {
    throw new UsageError(withHelpHint("seed needs a platform first: ios or android"));
  }
  if (model === undefined || model === "" || extra.length > 0) {
    throw new UsageError(withHelpHint("seed takes <platform> <model>"));
  }
  const osVersion = typeof values.os === "string" ? values.os : undefined;
  const imageTag = typeof values["image-tag"] === "string" ? values["image-tag"] : undefined;
  const client = await connectDaemonClient(environment, token);
  const termination = waitForTermination(environment.signals);
  try {
    const making = client.makeSeed(
      {
        model,
        platform,
        ...(osVersion === undefined ? {} : { osVersion }),
        ...(imageTag === undefined ? {} : { imageTag }),
      },
      {
        onProgress: (update) => {
          if (values.json !== true) environment.stderr.write(`${stageLine(update)}\n`);
        },
      },
    );
    // why: a Ctrl-C ends the wait only; the settle goes on in the daemon, and the call's late answer or failure is no one's to hear.
    making.catch(() => undefined);
    const answer = await Promise.race([making, termination.settled]);
    if (answer === undefined) {
      environment.stderr.write("stopped waiting; the settle goes on in the daemon\n");
      return 0;
    }
    if (values.json === true) writeResult((value) => environment.stdout.write(value), answer);
    else environment.stdout.write(`${outcomeLine(answer)}\n`);
    return 0;
  } finally {
    termination.dispose();
    await client.close();
  }
}

function kindPrefix(kind: SeedProgressUpdate["kind"]): string {
  const name = kind.platform === "ios" ? "iOS" : "Android";
  const tag = kind.imageTag === undefined ? "" : ` (${kind.imageTag})`;
  return escapeControl(`seed ${kind.model}, ${name} ${kind.osVersion}${tag}: `);
}

function stageLine({ kind, progress }: SeedProgressUpdate): string {
  const words =
    progress.stage === "waiting" ? STAGE_WORDS[progress.reason] : STAGE_WORDS[progress.stage];
  return `${kindPrefix(kind)}${words}`;
}

function outcomeLine(result: SeedMakeOutput): string {
  const size = result.sizeBytes === undefined ? "" : ` (${formatSize(result.sizeBytes)})`;
  if (result.outcome === "already-settled") return `${kindPrefix(result)}already settled${size}`;
  const took =
    result.settledAfterMs === undefined ? "" : ` in ${formatDuration(result.settledAfterMs)}`;
  return `${kindPrefix(result)}settled${took}${size}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export { run };

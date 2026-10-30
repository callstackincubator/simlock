import { commandArgs, subcommandOrUsage, UsageError, withHelpHint, writeResult } from "../args.js";
import type { WarmForgetOutput } from "../../admin/index.js";
import { connectDaemonClient } from "../connect.js";
import type { CommandContext } from "../tree.js";

const WARM_USAGE =
  "Usage: simlock warm forget <ios|android> <model> [<os>] [--mode <slim|full>] [--image-tag <tag>] [--json]\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsed = subcommandOrUsage(argv, context.path, environment.stdout, WARM_USAGE);
  if (parsed === 0) return 0;
  if (parsed.command !== "forget") {
    throw new UsageError(withHelpHint(`Unknown warm command: ${parsed.command}`));
  }
  const values = commandArgs(parsed.flagArgs, {
    help: { type: "boolean", short: "h" },
    "image-tag": { type: "string" },
    json: { type: "boolean" },
    mode: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(WARM_USAGE);
    return 0;
  }
  const [platform, model, osVersion, ...extra] = values.positionals;
  if (platform !== "ios" && platform !== "android") {
    throw new UsageError(withHelpHint("warm forget needs a platform first: ios or android"));
  }
  if (model === undefined || model === "" || extra.length > 0) {
    throw new UsageError(withHelpHint("warm forget takes <platform> <model> and an optional <os>"));
  }
  const mode = values.mode;
  if (mode !== undefined && mode !== "slim" && mode !== "full") {
    throw new UsageError(withHelpHint("--mode is slim or full"));
  }
  const imageTag = typeof values["image-tag"] === "string" ? values["image-tag"] : undefined;
  const client = await connectDaemonClient(environment, token);
  try {
    const result = await client.forgetWarmKind({
      model,
      platform,
      ...(osVersion === undefined ? {} : { osVersion }),
      ...(mode === undefined ? {} : { mode }),
      ...(imageTag === undefined ? {} : { imageTag }),
    });
    if (values.json) writeResult((value) => environment.stdout.write(value), result);
    else {
      const asked = { imageTag, mode, model, osVersion, platform };
      environment.stdout.write(describe(result.forgotten, asked));
    }
    return 0;
  } finally {
    await client.close();
  }
}

interface Kind {
  readonly platform: string;
  readonly model: string;
  readonly osVersion?: string | undefined;
  readonly mode?: string | undefined;
  readonly imageTag?: string | undefined;
}

function describe(forgotten: WarmForgetOutput["forgotten"], asked: Kind): string {
  if (forgotten.length === 0)
    return `The warm pool has learned no kind matching ${named(asked)}.\n`;
  const lines = forgotten.map((kind) => `Forgot ${named(kind)}.\n`);
  return `${lines.join("")}Its idle devices are no longer kept warm: the idle rules shut them down and delete them, unless a configured warmPool.targets entry keeps them.\n`;
}

// why: one spelling for a kind forgotten and a kind asked for: the words given, then mode and image tag in brackets.
function named(kind: Kind): string {
  const words = [kind.platform, kind.model, kind.osVersion].filter((word) => word !== undefined);
  const details = [kind.mode, kind.imageTag].filter((detail) => detail !== undefined);
  return details.length === 0 ? words.join(" ") : `${words.join(" ")} (${details.join(", ")})`;
}

export { run };

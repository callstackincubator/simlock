import { connectDaemonClient } from "../connect.js";
import { commandArgs, subcommandOrUsage, UsageError, withHelpHint, writeResult } from "../args.js";
import type { CommandContext } from "../tree.js";

const WORKER_INSTALL_INCOMPLETE_EXIT_CODE = 15;

const COMPONENT_USAGE =
  "Usage: simlock component install <ios|android> <version> [--worker <id>... | --all-workers]\n" +
  "       simlock component list [--platform <ios|android>]\n" +
  "       simlock component remove <ios|android> <version> [--dry-run] [--yes]\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsedSubcommand = subcommandOrUsage(
    argv,
    context.path,
    environment.stdout,
    COMPONENT_USAGE,
  );
  if (parsedSubcommand === 0) return 0;
  const { command, flagArgs } = parsedSubcommand;
  if (command === "list") return runComponentList(flagArgs, environment, token);
  if (command === "remove") return runComponentRemove(flagArgs, environment, token);
  if (command !== "install") {
    throw new UsageError(withHelpHint(`Unknown component command: ${String(command)}`));
  }
  const input = parseComponentInstallArgs(flagArgs);
  if (input === "help") {
    environment.stdout.write(COMPONENT_USAGE);
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  const onProgress = (progress: unknown): void => {
    environment.stderr.write(`${JSON.stringify(progress)}\n`);
  };
  try {
    if (input.workers === undefined) {
      writeResult(
        (value) => environment.stdout.write(value),
        await client.installComponent(input, { onProgress }),
      );
      return 0;
    }
    const { platform, version, workers } = input;
    const result = await client.installComponentOnWorkers(
      { platform, version, workers },
      { onProgress },
    );
    writeResult((value) => environment.stdout.write(value), result);
    return result.results.every(
      (entry) => entry.outcome === "installed" || entry.outcome === "already-installed",
    )
      ? 0
      : WORKER_INSTALL_INCOMPLETE_EXIT_CODE;
  } finally {
    await client.close();
  }
}

async function runComponentList(
  argv: readonly string[],
  environment: CommandContext["environment"],
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    platform: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(COMPONENT_USAGE);
    return 0;
  }
  if (values.positionals.length > 0) {
    throw new UsageError(withHelpHint("component list takes no positional arguments"));
  }
  if (values.platform !== undefined && values.platform !== "ios" && values.platform !== "android")
    throw new UsageError("component list --platform must be ios or android");
  const platform = values.platform as "ios" | "android" | undefined;
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      (value) => environment.stdout.write(value),
      await client.listComponents(platform === undefined ? {} : { platform }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function runComponentRemove(
  argv: readonly string[],
  environment: CommandContext["environment"],
  token: string | undefined,
): Promise<number> {
  const parsed = parseComponentRemoveArgs(argv);
  if (parsed === "help") {
    environment.stdout.write(COMPONENT_USAGE);
    return 0;
  }
  const { dryRun, platform, version } = parsed;
  if (!dryRun) {
    const confirmed =
      parsed.yes || (await environment.confirm?.(`Remove ${platform} ${version}? [y/N] `));
    if (confirmed !== true) {
      throw new UsageError("component remove requires confirmation or --yes");
    }
  }
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      (value) => environment.stdout.write(value),
      await client.removeComponent({ platform, version, ...(dryRun ? { dryRun } : {}) }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

function parseComponentRemoveArgs(argv: readonly string[]):
  | {
      readonly platform: "ios" | "android";
      readonly version: string;
      readonly dryRun: boolean;
      readonly yes: boolean;
    }
  | "help" {
  const values = commandArgs(argv, {
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean" },
  });
  if (values.help) return "help";
  const [platform, version, ...extra] = values.positionals;
  if (platform === undefined || version === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("Expected <ios|android> <version>"));
  }
  if (platform !== "ios" && platform !== "android") {
    throw new UsageError("component remove <platform> must be ios or android");
  }
  return { dryRun: values["dry-run"] === true, platform, version, yes: values.yes === true };
}

function parseComponentInstallArgs(argv: readonly string[]):
  | {
      readonly platform: "ios" | "android";
      readonly version: string;
      readonly workers?: "all" | string[];
    }
  | "help" {
  const values = commandArgs(argv, {
    "all-workers": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    worker: { type: "string", multiple: true },
  });
  if (values.help) return "help";
  const workers = installTargets(values.worker as string[] | undefined, values["all-workers"]);
  const [platform, version, ...extra] = values.positionals;
  if (platform === undefined || version === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("Expected <ios|android> <version>"));
  }
  if (platform !== "ios" && platform !== "android") {
    throw new UsageError("component install <platform> must be ios or android");
  }
  return workers === undefined ? { platform, version } : { platform, version, workers };
}

function installTargets(named: string[] | undefined, all: unknown): "all" | string[] | undefined {
  if (all !== true) return named;
  if (named !== undefined) {
    throw new UsageError("component install takes --worker or --all-workers, not both");
  }
  return "all";
}

export { run };

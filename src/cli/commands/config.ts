import { connectDaemonClient } from "../connect.js";
import {
  commandArgs,
  isHelp,
  requiredPositional,
  subcommand,
  UsageError,
  writeResult,
} from "../args.js";
import { errorMessage } from "../errors.js";
import type { CommandContext } from "../tree.js";

// fallow-ignore-next-line complexity -- config subcommand parsing is a single CLI boundary.
async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const { command, flagArgs } = subcommand(argv, context.path);
  if (command === undefined) {
    const client = await connectDaemonClient(environment, token);
    try {
      writeResult((value) => environment.stdout.write(value), await client.getConfig());
      return 0;
    } finally {
      await client.close();
    }
  }
  if (command === "get") {
    const values = commandArgs(flagArgs, {});
    const key = requiredPositional(values.positionals, "key");
    const client = await connectDaemonClient(environment, token);
    let config: Record<string, unknown>;
    try {
      config = await client.getConfig();
    } finally {
      await client.close();
    }
    const value = readConfigValue(config, key);
    if (value === undefined) throw new UsageError(`Unknown config key: ${key}`);
    writeResult((value) => environment.stdout.write(value), value);
    return 0;
  }
  if (command === "set") {
    const values = commandArgs(flagArgs, {});
    const [key, rawValue, ...extra] = values.positionals;
    if (key === undefined || rawValue === undefined || extra.length > 0)
      throw new UsageError("Usage: simlock config set <key> <value>");
    const config = await environment.readConfigFile();
    writeConfigValue(config, key, parseConfigValue(rawValue));
    try {
      await environment.validateConfig(config);
    } catch (error: unknown) {
      throw new UsageError(`Invalid config after setting ${key}: ${errorMessage(error)}`);
    }
    await environment.writeConfigFile(config);
    environment.stdout.write(
      `Updated ${key} in ${environment.configPath}; takes effect on daemon restart.\n`,
    );
    return 0;
  }
  if (isHelp(command)) {
    environment.stdout.write("Usage: simlock config [get <key>|set <key> <value>]\n");
    return 0;
  }
  throw new UsageError(`Unknown config command: ${String(command)}`);
}

function readConfigValue(value: Record<string, unknown>, key: string): unknown {
  let current: unknown = value;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writeConfigValue(config: Record<string, unknown>, key: string, value: unknown): void {
  const segments = key.split(".");
  if (segments.some((segment) => segment === ""))
    throw new UsageError(`Invalid config key: ${key}`);
  let target = config;
  for (const segment of segments.slice(0, -1)) {
    const next = target[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) target[segment] = {};
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1) as string] = value;
}

function parseConfigValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export { run };

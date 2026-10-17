import type { SimlockAdminClient } from "../../admin/index.js";
import { connectDaemonClient } from "../connect.js";
import { commandArgs, subcommandOrUsage, UsageError, withHelpHint } from "../args.js";
import type { CommandContext } from "../tree.js";

const DEVICE_USAGE =
  "Usage: simlock device add --platform <ios|android> <id> [--json]\n" +
  "       simlock device remove <id> [--json]\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsedSubcommand = subcommandOrUsage(argv, context.path, environment.stdout, DEVICE_USAGE);
  if (parsedSubcommand === 0) return 0;
  const { command, flagArgs } = parsedSubcommand;
  if (command !== "add" && command !== "remove") {
    throw new UsageError(withHelpHint(`Unknown device command: ${String(command)}`));
  }
  const parsed = parseDeviceArgs(command, flagArgs);
  if (parsed === "help") {
    environment.stdout.write(DEVICE_USAGE);
    return 0;
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const { line, result } =
      parsed.platform === undefined
        ? await removeDevice(client, parsed.id)
        : await addDevice(client, parsed.id, parsed.platform);
    environment.stdout.write(`${parsed.json ? JSON.stringify(result) : line}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

function parseDeviceArgs(
  command: "add" | "remove",
  argv: readonly string[],
):
  | {
      readonly id: string;
      readonly json: boolean;
      readonly platform: "ios" | "android" | undefined;
    }
  | "help" {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    ...(command === "add" ? { platform: { type: "string" as const } } : {}),
  });
  if (values.help) return "help";
  const [id, ...extra] = values.positionals;
  if (id === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint(`device ${command} takes exactly one <id>`));
  }
  const json = values.json === true;
  if (command === "remove") return { id, json, platform: undefined };
  if (values.platform !== "ios" && values.platform !== "android") {
    throw new UsageError(
      withHelpHint(
        "device add needs --platform ios or --platform android, to say which driver reads the device",
      ),
    );
  }
  return { id, json, platform: values.platform };
}

async function addDevice(
  client: SimlockAdminClient,
  id: string,
  platform: "ios" | "android",
): Promise<{ readonly line: string; readonly result: unknown }> {
  const result = await client.addDevice({ id, platform });
  return { line: describeEnrolled(result), result };
}

async function removeDevice(
  client: SimlockAdminClient,
  id: string,
): Promise<{ readonly line: string; readonly result: unknown }> {
  const result = await client.removeDevice({ id });
  return { line: describeRemoved(result), result };
}

function describeRemoved(result: { readonly driverDeviceId: string }): string {
  return `Removed ${result.driverDeviceId}. It is no longer enrolled; nothing on the device changed.`;
}

function describeEnrolled(result: {
  readonly appCount: number;
  readonly driverDeviceId: string;
  readonly model: string;
  readonly osVersion: string;
  readonly platform: "ios" | "android";
  readonly reenrolled: boolean;
}): string {
  const os = `${result.platform === "ios" ? "iOS" : "Android"} ${result.osVersion}`;
  const apps = `${String(result.appCount)} user app${result.appCount === 1 ? "" : "s"}`;
  return `Enrolled ${result.model} (${os}) as ${result.driverDeviceId}${result.reenrolled ? " again" : ""}, ${apps} recorded.`;
}

export { run };

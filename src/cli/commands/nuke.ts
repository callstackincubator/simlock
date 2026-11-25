import { connectDaemonClient } from "../connect.js";
import { commandArgs, UsageError, withHelpHint, writeResult } from "../args.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    "delete-devices": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    platform: { type: "string" },
    yes: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock nuke [--delete-devices] [--platform <ios|android>] [--yes]\n",
    );
    return 0;
  }
  const { platform } = values;
  if (platform !== undefined && platform !== "ios" && platform !== "android") {
    throw new UsageError(withHelpHint("nuke --platform takes ios or android"));
  }
  const confirmed =
    values.yes ??
    (await environment.confirm?.(
      `Nuke Simlock-managed ${platform === undefined ? "" : `${platform} `}devices? [y/N] `,
    ));
  if (!confirmed) throw new UsageError("nuke requires confirmation or --yes");
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      (value) => environment.stdout.write(value),
      await client.runNuke({
        deleteDevices: values["delete-devices"] === true,
        ...(platform === undefined ? {} : { platform }),
      }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

export { run };

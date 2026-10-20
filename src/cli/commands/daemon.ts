import { asDaemonRefusal, UsageError } from "../errors.js";
import { connectDaemonClient } from "../connect.js";
import { commandArgs, isHelp, subcommand, writeResult } from "../args.js";
import { consoleLines, formatStatus } from "../format.js";
import type { StatusGetOutput } from "../../admin/index.js";
import type { CommandContext } from "../tree.js";

// fallow-ignore-next-line complexity -- daemon subcommand parsing is a single CLI boundary.
async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const { command, flagArgs } = subcommand(argv, context.path);
  const values = commandArgs(flagArgs, {
    follow: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (command === undefined || isHelp(command) || values.help) {
    environment.stdout.write("Usage: simlock daemon <start|stop|status|logs [--follow]>\n");
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
  if (values.follow && command !== "logs") throw new UsageError("--follow applies only to logs");
  if (command === "start") {
    const client = await connectDaemonClient(environment, token, { launch: true });
    let status: StatusGetOutput;
    try {
      status = await client.getStatus();
    } finally {
      await client.close();
    }
    if (values.json) writeResult((value) => environment.stdout.write(value), { status: "running" });
    else {
      const lines = ["Daemon running", ...consoleLines(status.daemon)];
      environment.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  }
  if (command === "stop") {
    const client = await connectDaemonClient(environment, token, { launch: false });
    try {
      await client.stopDaemon();
    } finally {
      await client.close();
    }
    if (values.json)
      writeResult((value) => environment.stdout.write(value), { status: "stopping" });
    else environment.stdout.write("Daemon stopping\n");
    return 0;
  }
  if (command === "status") {
    try {
      const client = await connectDaemonClient(environment, token, { launch: false });
      try {
        const status = await client.getStatus();
        if (values.json) writeResult((value) => environment.stdout.write(value), status);
        else environment.stdout.write(`${formatStatus(status, environment.clock.now())}\n`);
      } finally {
        await client.close();
      }
      return 0;
    } catch (error: unknown) {
      const refusal = (await asDaemonRefusal(error)) as
        | { readonly code: string; readonly message: string }
        | undefined;
      if (refusal !== undefined) {
        if (values.json) {
          writeResult((value) => environment.stdout.write(value), {
            status: "handshake-refused",
            error: { code: refusal.code, message: refusal.message },
          });
        } else {
          environment.stdout.write(
            `Daemon handshake refused: ${refusal.code}: ${refusal.message}\n`,
          );
        }
        return 1;
      }
      if (values.json)
        writeResult((value) => environment.stdout.write(value), { status: "stopped" });
      else environment.stdout.write("Daemon stopped\n");
      return 0;
    }
  }
  if (command === "logs" && values.follow) {
    if (values.json) throw new UsageError("--follow cannot be combined with --json");
    if (environment.followLogFile === undefined) {
      throw new Error("Daemon log reader is unavailable");
    }
    await environment.followLogFile();
    return 0;
  }
  if (command === "logs") {
    if (environment.readLogFile === undefined) throw new Error("Daemon log reader is unavailable");
    const lines = (await environment.readLogFile()).trimEnd().split("\n");
    const output = lines.slice(-100).join("\n");
    if (values.json) writeResult((value) => environment.stdout.write(value), { logs: output });
    else environment.stdout.write(`${output}\n`);
    return 0;
  }
  throw new UsageError(`Unknown daemon command: ${String(command)}`);
}

export { run };

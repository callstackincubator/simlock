import { asDaemonRefusal, UsageError } from "../errors.js";
import { connectDaemonClient } from "../connect.js";
import { stopRunningDaemon } from "../daemon-service.js";
import { commandArgs, isHelp, subcommand, writeResult } from "../args.js";
import { consoleLines, formatStatus, serviceLine, type ServiceReport } from "../format.js";
import type { StatusGetOutput } from "../../admin/index.js";
import type { ServiceDefinition, ServiceManager } from "../../ports/index.js";
import type { CommandContext } from "../tree.js";

function serviceAccess(
  environment: CommandContext["environment"],
  command: "install" | "uninstall",
): {
  readonly manager: ServiceManager;
  readonly definition: () => Promise<ServiceDefinition>;
  readonly user: () => string;
} {
  const { service } = environment;
  if (service?.manager === undefined) {
    throw new UsageError(`daemon ${command} is supported on macOS and Linux only`);
  }
  return { manager: service.manager, definition: service.definition, user: service.user };
}

/** why: a container run with a uid that has no passwd entry makes the lookup throw; the hint is
 * advice, so install names a placeholder instead of failing after the service is already in place. */
function userForHint(lookupUser: () => string): string {
  try {
    return lookupUser();
  } catch {
    return "<user>";
  }
}

async function serviceReport(
  environment: CommandContext["environment"],
): Promise<ServiceReport | undefined> {
  const { service } = environment;
  if (service?.manager === undefined) return undefined;
  const definition = await service.definition();
  const state = await service.manager.state(definition);
  return { ...state, manager: service.manager.manager, name: definition.name };
}

/** why: the service lookup sits outside the connect `try`, so a failed manager call is not read as a stopped daemon. */
async function daemonStatus(context: CommandContext, json: boolean): Promise<number> {
  const { environment, token } = context;
  const write = (value: string): void => {
    environment.stdout.write(value);
  };
  let status: StatusGetOutput | undefined;
  try {
    const client = await connectDaemonClient(environment, token, { launch: false });
    try {
      status = await client.getStatus();
    } finally {
      await client.close();
    }
  } catch (error: unknown) {
    const refusal = (await asDaemonRefusal(error)) as
      | { readonly code: string; readonly message: string }
      | undefined;
    if (refusal === undefined) {
      status = undefined;
    } else {
      if (json) {
        writeResult(write, {
          status: "handshake-refused",
          error: { code: refusal.code, message: refusal.message },
        });
      } else {
        write(`Daemon handshake refused: ${refusal.code}: ${refusal.message}\n`);
      }
      return 1;
    }
  }
  const service = await serviceReport(environment);
  if (json) {
    writeResult(write, {
      ...(status ?? { status: "stopped" }),
      ...(service === undefined ? {} : { service }),
    });
    return 0;
  }
  write(
    status === undefined
      ? "Daemon stopped\n"
      : `${formatStatus(status, environment.clock.now())}\n`,
  );
  if (service !== undefined) write(`${serviceLine(service)}\n`);
  return 0;
}

async function startDaemon(context: CommandContext): Promise<StatusGetOutput> {
  const { environment, token } = context;
  const client = await connectDaemonClient(environment, token, { launch: true });
  try {
    return await client.getStatus();
  } finally {
    await client.close();
  }
}

function runningLines(status: StatusGetOutput): string {
  return `${["Daemon running", ...consoleLines(status.daemon)].join("\n")}\n`;
}

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
    environment.stdout.write(
      "Usage: simlock daemon <start|stop|status|logs [--follow]|install|uninstall>\n",
    );
    return 0;
  }
  if (values.positionals.length > 0) throw new UsageError("daemon accepts exactly one subcommand");
  if (values.follow && command !== "logs") throw new UsageError("--follow applies only to logs");
  if (command === "start") {
    const status = await startDaemon(context);
    if (values.json) writeResult((value) => environment.stdout.write(value), { status: "running" });
    else environment.stdout.write(runningLines(status));
    return 0;
  }
  if (command === "install") {
    const { manager, definition, user: lookupUser } = serviceAccess(environment, "install");
    const service = await definition();
    const stopped = await stopRunningDaemon(environment, token);
    await manager.install(service);
    const status = await startDaemon(context);
    if (values.json) {
      writeResult((value) => environment.stdout.write(value), {
        status: "installed",
        ...(stopped ? { stopped: true } : {}),
        service: {
          state: "installed",
          manager: manager.manager,
          name: service.name,
          path: service.path,
        },
      });
    } else {
      if (stopped) environment.stdout.write("Stopped the running daemon; leases are kept.\n");
      environment.stdout.write(`Service installed: ${service.name} (${manager.manager})\n`);
      environment.stdout.write(runningLines(status));
      environment.stdout.write(
        manager.manager === "systemd"
          ? `To start after a reboot without logging in, run: loginctl enable-linger ${userForHint(lookupUser)}\n`
          : "To start after a reboot, turn on automatic login for this user.\n",
      );
    }
    return 0;
  }
  if (command === "uninstall") {
    const { manager, definition } = serviceAccess(environment, "uninstall");
    const service = await definition();
    const state = await manager.state(service);
    const writeJson = (status: string, extra: Record<string, unknown>): void =>
      writeResult((value) => environment.stdout.write(value), {
        status,
        ...extra,
        service: {
          state: "not-installed",
          manager: manager.manager,
          name: service.name,
        },
      });
    if (state.state === "not-installed") {
      if (values.json) writeJson("not-installed", {});
      else environment.stdout.write(`Service not installed: ${service.name}\n`);
      return 0;
    }
    const stopped = await stopRunningDaemon(environment, token);
    await manager.uninstall(service);
    if (values.json) writeJson("removed", stopped ? { stopped: true } : {});
    else {
      if (stopped) environment.stdout.write("Daemon stopping\n");
      environment.stdout.write(`Service removed: ${service.name} (${manager.manager})\n`);
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
  if (command === "status") return daemonStatus(context, values.json === true);
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

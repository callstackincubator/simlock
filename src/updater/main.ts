import { fileURLToPath } from "node:url";

import { connectSimlockAdmin } from "../admin/index.js";
import {
  daemonDataDirectory,
  NodeFilesystem,
  NodeIpcTransport,
  NodeNpmCli,
  NodeProcessRunner,
  NodeProcessSupervisor,
  resolveDaemonSocketPath,
  resolveSimlockHome,
  SystemClock,
} from "../ports/index.js";
import { parseUpdaterArgs, runUpdater, type DaemonProbe, type UpdaterArguments } from "./index.js";

// why: every import above is static, so the whole updater is in memory before the install replaces its files on disk.
function createProbe(dataDirectory: string, filesystem: NodeFilesystem): DaemonProbe {
  const endpoint = resolveDaemonSocketPath(dataDirectory);
  const connect = async (): Promise<Awaited<ReturnType<typeof connectSimlockAdmin>>> => {
    const credential = (await filesystem.readFile(`${dataDirectory}/admin.token`)).trim();
    return connectSimlockAdmin({ endpoint, ipc: new NodeIpcTransport(), credential });
  };
  return {
    stop: async () => {
      const client = await connect();
      try {
        await client.stopDaemon();
      } finally {
        await client.close();
      }
    },
    answers: () => filesystem.exists(endpoint),
    state: async () => {
      try {
        const client = await connect();
        try {
          const status = await client.getStatus();
          return { health: status.daemon.health, version: client.daemonVersion };
        } finally {
          await client.close();
        }
      } catch {
        return undefined;
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function update(args: UpdaterArguments): Promise<number> {
  const filesystem = new NodeFilesystem();
  const dataDirectory = daemonDataDirectory(resolveSimlockHome(process.env), args.role);
  return runUpdater({
    ...args,
    npm: new NodeNpmCli({ runner: new NodeProcessRunner(), filesystem, dataDirectory }),
    probe: createProbe(dataDirectory, filesystem),
    processes: new NodeProcessRunner(),
    supervisor: new NodeProcessSupervisor(),
    filesystem,
    clock: new SystemClock(),
    packageRoot: fileURLToPath(new URL("../../", import.meta.url)),
    dataDirectory,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

async function main(): Promise<number> {
  try {
    return await update(parseUpdaterArgs(process.argv.slice(2)));
  } catch (error: unknown) {
    process.stderr.write(`updater failed: ${describe(error)}\n`);
    return 1;
  }
}

process.exitCode = await main();
// why: a probe call that timed out can leave its socket open, and that handle must not keep the updater alive.
process.exit();

import { fileURLToPath } from "node:url";

import {
  daemonDataDirectory,
  NodeFilesystem,
  NodeNpmCli,
  NodeProcessRunner,
  NodeProcessSupervisor,
  resolveSimlockHome,
  SystemClock,
} from "../ports/index.js";
// why: every import here is static, so the whole updater is in memory before the install replaces its files on disk.
import { createDaemonProbe, parseUpdaterArgs, runUpdater, type UpdaterArguments } from "./index.js";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function update(args: UpdaterArguments): Promise<number> {
  const filesystem = new NodeFilesystem();
  const dataDirectory = daemonDataDirectory(resolveSimlockHome(process.env), args.role);
  return runUpdater({
    ...args,
    npm: new NodeNpmCli({ runner: new NodeProcessRunner(), filesystem, dataDirectory }),
    probe: createDaemonProbe({ dataDirectory, filesystem }),
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

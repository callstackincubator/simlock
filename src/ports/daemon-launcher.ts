import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

/** Starts the detached daemon owned by the operating system rather than the CLI. */
export interface DaemonLauncher {
  launch(): Promise<void>;
}

export interface NodeDaemonLauncherOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly logPath: string;
}

export class NodeDaemonLauncher implements DaemonLauncher {
  constructor(private readonly options: NodeDaemonLauncherOptions) {}

  async launch(): Promise<void> {
    await mkdir(dirname(this.options.logPath), { recursive: true });
    const log = await open(this.options.logPath, "a");
    try {
      const child = spawn(this.options.command, this.options.args, {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  }
}

export class FakeDaemonLauncher implements DaemonLauncher {
  launches = 0;

  constructor(private readonly onLaunch: () => Promise<void> | void = () => undefined) {}

  async launch(): Promise<void> {
    this.launches += 1;
    await this.onLaunch();
  }
}

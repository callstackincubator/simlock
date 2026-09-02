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
  /**
   * The *resolved* `SIMLOCK_HOME` the launching process is using. It is exported into the
   * daemon's environment rather than left to be inherited, because a relative
   * `SIMLOCK_HOME` resolves against whatever directory the process reading it happens to
   * be standing in -- and the two processes agreeing only because one spawned the other
   * from its own cwd is an assumption, not a guarantee. It now decides where tens of
   * gigabytes of devices live, and a daemon that resolved it differently would build its
   * device roots somewhere the CLI never looks.
   */
  readonly simlockHome: string;
}

export class NodeDaemonLauncher implements DaemonLauncher {
  constructor(private readonly options: NodeDaemonLauncherOptions) {}

  async launch(): Promise<void> {
    await mkdir(dirname(this.options.logPath), { recursive: true });
    const log = await open(this.options.logPath, "a");
    try {
      const child = spawn(this.options.command, this.options.args, {
        detached: true,
        // Explicit rather than relying on spawn's default: the daemon must inherit
        // overrides like SIMLOCK_DRIVERS_MODULE from whichever frontend (CLI/MCP)
        // auto-launched it, and must be told the home this one already resolved.
        env: { ...process.env, SIMLOCK_HOME: this.options.simlockHome },
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

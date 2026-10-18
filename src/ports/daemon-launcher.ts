import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

/** Starts the detached daemon owned by the operating system rather than the CLI. */
export interface DaemonLauncher {
  launch(): Promise<void>;
}

/**
 * why: this is not an expected wait -- a daemon boots in a second or two; 20 s is the ceiling
 * for a loaded machine, long enough that a start is not reported failed while the daemon the
 * caller itself launched is still coming up. It stays under the 30 s a caller gives the CLI
 * process, so a start that gives up still gets to say so itself. Both frontends' launch-then-
 * poll loops read this one bound; neither writes a number of its own (architecture rule 10).
 */
export const DAEMON_STARTUP_TIMEOUT_MS = 20_000;

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
    // why: 0600 at creation, like the other files that hold secrets or state under the home:
    // this `open` is what first creates `daemon.log` for an auto-launched daemon -- the daemon's
    // own sink only appends to the file this one made.
    const log = await open(this.options.logPath, "a", 0o600);
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

import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type { DaemonRole } from "./paths.js";

export interface UpdaterLaunch {
  readonly entry: string;
  readonly from: string;
  readonly to: string;
  readonly role: DaemonRole;
  readonly pid: number;
  readonly simlockHome: string;
  readonly logPath: string;
}

export interface LaunchedUpdater {
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number | null>;
}

export interface UpdaterLauncher {
  launch(options: UpdaterLaunch): Promise<LaunchedUpdater>;
}

export class NodeUpdaterLauncher implements UpdaterLauncher {
  async launch(options: UpdaterLaunch): Promise<LaunchedUpdater> {
    await mkdir(dirname(options.logPath), { recursive: true });
    const log = await open(options.logPath, "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [
          options.entry,
          "--from",
          options.from,
          "--to",
          options.to,
          "--pid",
          String(options.pid),
          ...(options.role === "gateway" ? ["--gateway"] : []),
        ],
        {
          detached: true,
          env: { ...process.env, SIMLOCK_HOME: options.simlockHome },
          stdio: ["ignore", "pipe", log.fd],
        },
      );
      const exited = new Promise<number | null>((resolve) => {
        child.once("close", (code) => resolve(code));
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      if (child.stdout === null) throw new Error("the updater has no stdout pipe");
      return { lines: createInterface({ input: child.stdout }), exited };
    } finally {
      await log.close();
    }
  }
}

// fallow-ignore-next-line unused-export -- the daemon's update call (#836) tests against it.
export class FakeUpdaterLauncher implements UpdaterLauncher {
  readonly launches: UpdaterLaunch[] = [];
  readonly #lines: string[] = [];
  #exit: number | null = 0;

  constructor(script: { readonly lines?: readonly string[]; readonly exit?: number | null } = {}) {
    this.#lines.push(...(script.lines ?? []));
    this.#exit = script.exit === undefined ? 0 : script.exit;
  }

  async launch(options: UpdaterLaunch): Promise<LaunchedUpdater> {
    this.launches.push(options);
    const lines = [...this.#lines];
    return {
      lines: (async function* (): AsyncGenerator<string> {
        yield* lines;
      })(),
      exited: Promise.resolve(this.#exit),
    };
  }
}

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
  async launch(_options: UpdaterLaunch): Promise<LaunchedUpdater> {
    return {
      lines: (async function* (): AsyncGenerator<string> {})(),
      exited: Promise.resolve(null),
    };
  }
}

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

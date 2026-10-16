import type { Filesystem, ProcessRunner, TcpProbe } from "../../ports/index.js";

export const DEFAULT_ADB_PORT = 5037;

const SIMLOCK_VERSION_TIMEOUT_MS = 30_000;
const SERVER_VERSION_TIMEOUT_MS = 5_000;
const HOST_VERSION_REQUEST = "000chost:version";
const HOST_VERSION_REPLY = /^OKAY0004([0-9a-fA-F]{4})$/;

const SIMLOCK_VERSION_NAME = "Simlock's adb version";
const SERVER_VERSION_NAME = `the adb server's version on port ${String(DEFAULT_ADB_PORT)}`;

const NO_COMMAND_NOTE =
  "No command goes to physical Android devices until they match, and Simlock will not restart that server.";

export type AdbGateAnswer =
  | { readonly open: true }
  | {
      readonly open: false;
      readonly kind: "mismatch";
      readonly message: string;
    }
  | {
      readonly open: false;
      readonly kind: "unreadable";
      readonly read: string;
      readonly message: string;
    };

export interface DefaultAdbServerGateOptions {
  readonly adb: string;
  readonly env: NodeJS.ProcessEnv;
  readonly filesystem: Filesystem;
  readonly processRunner: ProcessRunner;
  readonly tcpProbe: TcpProbe;
}

export class DefaultAdbServerGate {
  readonly #options: DefaultAdbServerGateOptions;
  #simlock: { readonly key: string; readonly protocol: number } | undefined;

  constructor(options: DefaultAdbServerGateOptions) {
    this.#options = options;
  }

  async check(): Promise<AdbGateAnswer> {
    const simlock = await this.#simlockProtocol();
    if (simlock === undefined) return unreadable(SIMLOCK_VERSION_NAME);

    let reply: string;
    try {
      reply = await this.#options.tcpProbe.send(
        DEFAULT_ADB_PORT,
        HOST_VERSION_REQUEST,
        SERVER_VERSION_TIMEOUT_MS,
      );
    } catch (error) {
      // why: only a refused connection proves nothing listens, and then adb starts a server of
      // its own version; every other failure could be a server we cannot read.
      if ((error as { code?: unknown } | undefined)?.code === "ECONNREFUSED") return { open: true };
      return unreadable(SERVER_VERSION_NAME);
    }

    const matched = HOST_VERSION_REPLY.exec(reply);
    if (matched?.[1] === undefined) return unreadable(SERVER_VERSION_NAME);
    const server = Number.parseInt(matched[1], 16);
    if (server === simlock) return { open: true };
    return {
      kind: "mismatch",
      message: `the adb server on port ${String(DEFAULT_ADB_PORT)} speaks protocol ${String(server)} and Simlock's adb speaks ${String(simlock)}. ${NO_COMMAND_NOTE}`,
      open: false,
    };
  }

  async #simlockProtocol(): Promise<number | undefined> {
    let key: string;
    try {
      const stat = await this.#options.filesystem.stat(this.#options.adb);
      key = `${String(stat.modifiedAtMs)}:${String(stat.size)}`;
    } catch {
      return undefined;
    }
    if (this.#simlock?.key === key) return this.#simlock.protocol;

    try {
      const result = await this.#options.processRunner.run(this.#options.adb, ["version"], {
        env: this.#options.env,
        timeoutMs: SIMLOCK_VERSION_TIMEOUT_MS,
      });
      if (result.code !== 0) return undefined;
      const firstLine = result.stdout.split("\n")[0] ?? "";
      const matched = /(\d+)\s*$/.exec(firstLine);
      if (matched?.[1] === undefined) return undefined;
      const protocol = Number.parseInt(matched[1], 10);
      this.#simlock = { key, protocol };
      return protocol;
    } catch {
      return undefined;
    }
  }
}

function unreadable(read: string): AdbGateAnswer {
  return {
    kind: "unreadable",
    message: `${read} is unreadable, so it cannot be compared with the other. ${NO_COMMAND_NOTE}`,
    open: false,
    read,
  };
}
